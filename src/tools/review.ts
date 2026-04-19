import { tool } from 'ai';
import { z } from 'zod';

import type { ToolFactoryOptions } from './types';
import {
  classifyPath,
  joinAddedLines,
  joinRemovedLines,
  parseUnifiedDiff,
  totalLineChanges,
  type DiffFile,
  type FileKind,
} from './diff-analysis';

export type ChangeCategory =
  | 'feature'
  | 'fix'
  | 'refactor'
  | 'performance'
  | 'docs'
  | 'tests'
  | 'build_or_deps'
  | 'infrastructure'
  | 'security'
  | 'chore';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type TimingVerdict = 'go' | 'caution' | 'hold';

const DEFAULT_MAX_STEPS = 12;
const MAX_STEPS = 30;
const DEFAULT_MAX_QUESTIONS = 10;
const MAX_QUESTIONS = 25;
const MAX_DIFF_LENGTH = 400_000;
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function uniqueNonEmpty(values: string[], maxCount: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= maxCount) break;
  }
  return out;
}

function ensureDiff(diff: string) {
  if (diff.trim() === '') throw new Error('`diff` must be a non-empty string');
  if (diff.length > MAX_DIFF_LENGTH) {
    throw new Error(`diff is too long (${diff.length} chars); max supported is ${MAX_DIFF_LENGTH}`);
  }
}

function categoryFor(file: DiffFile): ChangeCategory {
  const kind = classifyPath(file.path);
  if (kind === 'test') return 'tests';
  if (kind === 'docs') return 'docs';
  if (kind === 'deps' || kind === 'lockfile') return 'build_or_deps';
  if (kind === 'ci' || kind === 'infra') return 'infrastructure';
  if (kind === 'security' || kind === 'migration') return 'security';

  const added = file.hunks
    .flatMap(hunk => hunk.addedLines)
    .join('\n')
    .toLowerCase();
  const removed = file.hunks
    .flatMap(hunk => hunk.removedLines)
    .join('\n')
    .toLowerCase();

  if (/\bfix\b|\bbug\b|regression|crash|null pointer|off[- ]by[- ]one/.test(added)) return 'fix';
  if (/\bperf\b|\bperformance\b|optimi[sz]e|throughput|latency|cache/.test(added))
    return 'performance';
  if (file.isNew || /\bfeat\b|\bfeature\b|\bintroduce\b|\benable\b|\badd\b/.test(added))
    return 'feature';
  if (added.length > 0 && removed.length > 0 && file.additions <= file.deletions * 1.5)
    return 'refactor';
  return 'chore';
}

function categoryTitle(category: ChangeCategory) {
  switch (category) {
    case 'feature':
      return 'Features';
    case 'fix':
      return 'Bug fixes';
    case 'refactor':
      return 'Refactors';
    case 'performance':
      return 'Performance';
    case 'docs':
      return 'Documentation';
    case 'tests':
      return 'Tests';
    case 'build_or_deps':
      return 'Build & dependencies';
    case 'infrastructure':
      return 'Infrastructure & CI';
    case 'security':
      return 'Security & data';
    case 'chore':
      return 'Chores';
  }
}

function pathToHumanArea(path: string) {
  if (path === '/dev/null') return 'unknown';
  const parts = path.split('/');
  if (parts.length === 1) return parts[0]!;
  const head = parts.slice(0, -1).filter(part => part !== 'src' && part !== 'lib');
  if (head.length === 0) return parts[0]!;
  return head.slice(-2).join('/') || head.join('/');
}

function summarizeFile(file: DiffFile) {
  const verb = file.isNew
    ? 'adds'
    : file.isDeleted
      ? 'removes'
      : file.isRename
        ? `renames from \`${file.oldPath}\` to`
        : 'updates';
  const sizeNote =
    file.additions + file.deletions > 200
      ? ` (large change: +${file.additions}/-${file.deletions})`
      : ` (+${file.additions}/-${file.deletions})`;
  return `${verb} \`${file.path}\`${sizeNote}`;
}

function buildReleaseNotes(files: DiffFile[], prTitle: string | null, projectName: string | null) {
  const features: string[] = [];
  const fixes: string[] = [];
  const breaking: string[] = [];

  for (const file of files) {
    const category = categoryFor(file);
    const area = pathToHumanArea(file.path);
    if (category === 'feature') {
      features.push(`${file.isNew ? 'New' : 'Improved'} ${area}`);
    } else if (category === 'fix') {
      fixes.push(`Fixed an issue in ${area}`);
    }

    if (file.isDeleted && classifyPath(file.path) === 'src') {
      breaking.push(`Removed \`${file.path}\` -- update any external imports.`);
    }
  }

  const added = joinAddedLines(files);
  const removed = joinRemovedLines(files);
  if (/\bremoved\s+(?:export|public api|deprecated)/i.test(removed))
    breaking.push('Public API surface reduced -- check imports.');
  if (
    /\b(BREAKING|breaking change)\b/.test(added) ||
    /\b(BREAKING|breaking change)\b/i.test(prTitle ?? '')
  ) {
    breaking.push('Marked as a breaking change by the author.');
  }

  const subject = prTitle?.trim() || features[0] || fixes[0] || 'maintenance update';
  const bullets = uniqueNonEmpty([...features, ...fixes], 8);
  if (bullets.length === 0) bullets.push('Internal improvements and maintenance.');

  return {
    headline: projectName ? `${projectName}: ${subject}` : subject,
    bullets,
    breaking_changes: uniqueNonEmpty(breaking, 5),
  };
}

function buildInternalChangelog(files: DiffFile[]) {
  const buckets = new Map<ChangeCategory, string[]>();
  for (const file of files) {
    const category = categoryFor(file);
    const items = buckets.get(category) ?? [];
    items.push(summarizeFile(file));
    buckets.set(category, items);
  }

  const order: ChangeCategory[] = [
    'feature',
    'fix',
    'performance',
    'security',
    'refactor',
    'tests',
    'docs',
    'build_or_deps',
    'infrastructure',
    'chore',
  ];
  const sections = order
    .map(category => {
      const items = buckets.get(category);
      return items && items.length > 0 ? { category, title: categoryTitle(category), items } : null;
    })
    .filter(
      (value): value is { category: ChangeCategory; title: string; items: string[] } =>
        value !== null,
    );

  return { sections };
}

function whyForKind(kind: FileKind) {
  switch (kind) {
    case 'migration':
      return 'Schema changes ship through deploy + rollback windows; correctness here matters most.';
    case 'security':
      return 'Authentication / permission / secret-handling code; small bugs here have outsized blast radius.';
    case 'infra':
      return 'Deploy, runtime, and packaging configuration -- regressions can take down all environments.';
    case 'ci':
      return 'CI configuration governs every other PR; mistakes here cause team-wide friction.';
    case 'src':
      return 'Application logic -- reviewer focus on correctness and contract changes.';
    case 'test':
      return 'Test coverage -- check the assertions actually pin the behavior being claimed.';
    case 'docs':
      return 'Documentation -- check that examples still match real APIs.';
    case 'deps':
      return 'Dependency manifest -- minor/major bumps may pull in transitive surprises.';
    case 'lockfile':
      return 'Lockfile churn -- skim for unexpected major-version transitive bumps.';
    case 'config':
      return 'Runtime configuration -- ensure each environment has the corresponding value.';
    case 'asset':
      return 'Static asset -- usually safe; verify build pipeline still picks it up.';
    case 'unknown':
      return 'Unclassified file -- inspect to understand its role.';
  }
}

function scrutinizeForFile(file: DiffFile) {
  const out: string[] = [];
  const added = file.hunks.flatMap(hunk => hunk.addedLines).join('\n');
  const kind = classifyPath(file.path);

  if (kind === 'migration') out.push('Verify the migration is backward-compatible during rollout.');
  if (kind === 'security')
    out.push('Walk through every code path that hits this file -- security-sensitive surface.');
  if (/\b(?:eval\(|child_process|spawn\(|exec\(|os\.system\()/.test(added))
    out.push('eval/exec/spawn introduced -- confirm every input is trusted.');
  if (/\bcatch\s*\([^)]*\)\s*\{\s*\}|except\s+[A-Za-z][\w.]*:\s*pass\b/.test(added))
    out.push('Caught error appears to be silenced -- confirm intent and add observability.');
  if (/(it|describe|test)\.skip\b|\bxit\b|@pytest\.mark\.skip/.test(added))
    out.push('Test is skipped -- confirm tracking issue and re-enable plan.');
  if (file.isDeleted) out.push('Confirm no remaining imports or runtime references to this path.');
  if (file.isRename)
    out.push('Search for any string-based references that did not follow the rename.');
  if (file.additions + file.deletions > 300)
    out.push('Large change -- request the author to highlight the 2-3 most important hunks.');
  if (out.length === 0)
    out.push('Skim for naming, error handling, and unexpected behavior changes.');
  return out;
}

function buildWalkthrough(files: DiffFile[], maxSteps: number) {
  const priority = (file: DiffFile) => {
    const kind = classifyPath(file.path);
    if (kind === 'migration' || kind === 'security') return 0;
    if (kind === 'infra' || kind === 'ci') return 1;
    if (file.isNew || file.isDeleted || file.isRename) return 2;
    if (kind === 'src') return 3;
    if (kind === 'config' || kind === 'deps') return 4;
    if (kind === 'test') return 5;
    if (kind === 'docs' || kind === 'lockfile' || kind === 'asset') return 6;
    return 7;
  };

  const sorted = [...files]
    .map(file => ({ file, priority: priority(file), size: file.additions + file.deletions }))
    .sort((a, b) => a.priority - b.priority || b.size - a.size)
    .map(item => item.file);

  return {
    ordered_steps: sorted.slice(0, maxSteps).map((file, index) => ({
      order: index + 1,
      area: file.path,
      what_changed: `${file.isNew ? 'introduces a new file' : file.isDeleted ? 'removes a file' : file.isRename ? `renames from \`${file.oldPath}\`` : `edits ${file.additions + file.deletions} line(s)`} (+${file.additions}/-${file.deletions}).`,
      why_it_matters: whyForKind(classifyPath(file.path)),
      scrutinize: scrutinizeForFile(file),
    })),
  };
}

function countByKind(files: DiffFile[]) {
  const out: Partial<Record<FileKind, number>> = {};
  for (const file of files) {
    const kind = classifyPath(file.path);
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

function levelFor(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

function scoreRisk(
  files: DiffFile[],
  added: string,
  totals: { additions: number; deletions: number },
  coverageDelta: number | null,
  bugDensity: Map<string, number>,
) {
  const drivers: Array<{ signal: string; weight: number; evidence: string }> = [];
  const kinds = countByKind(files);
  const pushDriver = (signal: string, weight: number, evidence: string) =>
    drivers.push({ signal, weight, evidence });

  if (kinds.migration)
    pushDriver('database migration changed', 25, `${kinds.migration} migration file(s) modified`);
  if (/\b(DROP|TRUNCATE|ALTER\s+TABLE\s+\S+\s+DROP)\b/i.test(added))
    pushDriver('destructive schema change', 30, 'added lines contain DROP/TRUNCATE/ALTER ... DROP');
  if (kinds.security)
    pushDriver(
      'security-sensitive path touched',
      20,
      `${kinds.security} file(s) under auth/security/permission paths`,
    );
  if (kinds.deps)
    pushDriver(
      'dependency manifest changed',
      10,
      `${kinds.deps} dependency manifest file(s) changed`,
    );
  if (kinds.lockfile && (kinds.deps ?? 0) === 0)
    pushDriver(
      'lockfile changed without manifest update',
      8,
      `${kinds.lockfile} lockfile(s) updated; manifest unchanged`,
    );
  if (kinds.infra)
    pushDriver(
      'infrastructure or deploy config touched',
      18,
      `${kinds.infra} infra/deploy file(s) modified`,
    );
  if (kinds.ci) pushDriver('CI configuration changed', 8, `${kinds.ci} CI file(s) modified`);
  if (kinds.config)
    pushDriver('app configuration changed', 6, `${kinds.config} config file(s) modified`);

  const srcChanged = (kinds.src ?? 0) + (kinds.security ?? 0);
  const testChanged = kinds.test ?? 0;
  if (srcChanged > 0 && testChanged === 0)
    pushDriver(
      'source changes without test changes',
      14,
      `${srcChanged} source file(s) changed, 0 test file(s) changed`,
    );

  const totalLines = totals.additions + totals.deletions;
  if (totalLines > 1000)
    pushDriver(
      'very large diff',
      18,
      `${totalLines} total line changes across ${files.length} file(s)`,
    );
  else if (totalLines > 400)
    pushDriver('large diff', 10, `${totalLines} total line changes across ${files.length} file(s)`);
  if (files.length > 25) pushDriver('wide blast radius', 10, `${files.length} files touched`);

  if (coverageDelta !== null && coverageDelta < 0)
    pushDriver(
      'test coverage dropped',
      coverageDelta <= -3 ? 12 : 6,
      `coverage delta = ${coverageDelta.toFixed(2)}pp`,
    );

  if (bugDensity.size) {
    let hot = 0;
    let topPath = '';
    let topCount = 0;
    for (const file of files) {
      const count = bugDensity.get(file.path) ?? 0;
      if (count > 0) hot++;
      if (count > topCount) {
        topCount = count;
        topPath = file.path;
      }
    }
    if (hot > 0)
      pushDriver(
        'historically bug-prone files touched',
        Math.min(15, 4 + hot * 2),
        `${hot} touched file(s) have prior bugs (top: ${topPath} @ ${topCount})`,
      );
  }

  if (/\b(?:TODO|FIXME|XXX)\b/.test(added))
    pushDriver('new TODO/FIXME markers', 3, 'added lines contain TODO/FIXME/XXX');
  if (/(it|describe|test)\.skip\b|\bxit\b|@pytest\.mark\.skip|t\.skip\(/.test(added))
    pushDriver('tests skipped or disabled', 8, 'added lines disable a test');
  if (/\b(?:console\.log|debugger|print\()/.test(added))
    pushDriver('debug output left in', 4, 'added lines contain console.log/print/debugger');
  if (/\b(?:eval\(|child_process|spawn\(|exec\(|os\.system\()/.test(added))
    pushDriver('shell or eval execution introduced', 12, 'added lines invoke eval/exec');
  if (
    /\b(?:setTimeout|sleep|retry|backoff|Promise\.all|asyncio\.gather|goroutine|sync\.(Mutex|RWMutex))/i.test(
      added,
    )
  )
    pushDriver('concurrency or timing primitives introduced', 6, 'async/lock/retry usage');

  const score = Math.min(
    100,
    drivers.reduce((sum, driver) => sum + driver.weight, 0),
  );
  return {
    score,
    level: levelFor(score),
    drivers: drivers.sort((a, b) => b.weight - a.weight),
    files_changed: files.length,
    additions: totals.additions,
    deletions: totals.deletions,
    file_kinds: kinds,
  };
}

function buildQuestions(
  files: DiffFile[],
  added: string,
  prTitle: string | null,
  prDescription: string | null,
) {
  const out: Array<{ topic: string; question: string; why: string; evidence: string | null }> = [];
  const has = (re: RegExp) => re.test(added);
  const kinds = countByKind(files);

  if (
    kinds.migration ||
    has(/\bALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|ADD\s+COLUMN|RENAME\s+COLUMN/i)
  ) {
    out.push({
      topic: 'schema migration',
      question:
        'Is this migration backward-compatible during a rolling deploy? What is the order: ship code that tolerates both shapes, then migrate, then drop the old shape?',
      why: 'Schema and code must overlap safely while old and new pods run side-by-side.',
      evidence: 'migration files or ALTER/CREATE/DROP TABLE in the diff',
    });
  }

  if (has(/process\.env\.[A-Z0-9_]+|os\.environ\[|os\.getenv\(/)) {
    out.push({
      topic: 'configuration',
      question:
        'New environment variables appear here -- where are they set in each deployment environment, and what is the default for local dev?',
      why: 'Missing env vars cause silent fallbacks or crash-on-boot in production.',
      evidence: 'process.env / os.environ access added',
    });
  }

  if (has(/(it|describe|test)\.skip\b|\bxit\b|@pytest\.mark\.skip|t\.skip\(/)) {
    out.push({
      topic: 'tests',
      question:
        'Why is this test being skipped? Is there a tracking issue, and what guarantees the underlying behavior?',
      why: 'Skipped tests rot quickly and hide regressions.',
      evidence: 'test skip marker added in diff',
    });
  }

  if (has(/\bcatch\s*\([^)]*\)\s*\{\s*\}|except\s+[A-Za-z][\w.]*:\s*pass\b|\b_\s*=\s*err\b/)) {
    out.push({
      topic: 'error handling',
      question:
        'These caught errors look swallowed. Is silencing them intentional, and if so, are we logging or metricizing the suppression?',
      why: 'Silent catches are a frequent source of debuggability outages.',
      evidence: 'empty catch / except pass / discarded error',
    });
  }

  if (has(/\b(?:eval\(|child_process|spawn\(|exec\(|os\.system\()/)) {
    out.push({
      topic: 'security',
      question:
        'eval/exec/spawn is being introduced -- is every input here strictly trusted, and how is injection prevented?',
      why: 'Shell or eval surfaces are the highest-leverage RCE vectors.',
      evidence: 'eval/exec/spawn call in added lines',
    });
  }

  if (has(/\b(?:console\.log|debugger|print\()/)) {
    out.push({
      topic: 'cleanup',
      question:
        'Is the new console.log / print / debugger intended to ship? If yes, should it be a structured log instead?',
      why: 'Stray debug output confuses log search and pollutes user devtools.',
      evidence: 'console.log / debugger / print in added lines',
    });
  }

  if (kinds.deps && !kinds.lockfile) {
    out.push({
      topic: 'dependencies',
      question:
        'Manifest changed without a lockfile update -- did the install step run and was the lockfile committed?',
      why: 'Drift between manifest and lockfile produces non-reproducible builds.',
      evidence: `${kinds.deps} dependency file(s) changed; 0 lockfiles updated`,
    });
  }

  if (kinds.lockfile && !kinds.deps) {
    out.push({
      topic: 'dependencies',
      question:
        'Lockfile-only change -- which transitive packages moved, and did anything pull in a major version?',
      why: 'Silent transitive bumps are a classic source of “works locally” failures.',
      evidence: `${kinds.lockfile} lockfile(s) modified, manifests unchanged`,
    });
  }

  if (has(/\b(?:setTimeout|sleep|retry|backoff)\b|Promise\.all|asyncio\.gather/i)) {
    out.push({
      topic: 'reliability',
      question:
        'New async/timer/retry logic appears -- what bounds the retry budget and what happens on partial success?',
      why: 'Unbounded retries amplify outages; partial-success paths are easy to forget.',
      evidence: 'retry/timeout/parallel-await primitive added',
    });
  }

  if (has(/\bfeature_?flag|flag\.[A-Za-z_]+\.enabled|\bunleash|\blaunchdarkly/i)) {
    out.push({
      topic: 'feature flag',
      question:
        'Is this guarded by a flag with a known rollout plan, and is there an off-switch we can flip without redeploy?',
      why: 'Flag-guarded changes are far safer to roll forward than code-deploy-only changes.',
      evidence: 'feature flag reference in diff',
    });
  }

  for (const file of files) {
    if (file.isDeleted) {
      out.push({
        topic: 'deletion',
        question: `\`${file.path}\` is deleted -- where are its callers, and have all references been updated?`,
        why: 'Removed modules often leave dangling imports or runtime lookups behind.',
        evidence: 'file marked as deleted in diff',
      });
      break;
    }
  }

  for (const file of files) {
    if (file.isRename) {
      out.push({
        topic: 'rename',
        question: `\`${file.oldPath}\` was renamed to \`${file.path}\` -- are all imports, configs, and docs updated?`,
        why: 'Renames break implicit references that grep would catch but the type checker may not.',
        evidence: 'git rename detected',
      });
      break;
    }
  }

  if (prTitle && /\b(quick|small|trivial|wip|hotfix)\b/i.test(prTitle) && files.length > 5) {
    out.push({
      topic: 'scope',
      question: `Title says "${prTitle.trim()}" but ${files.length} files are touched -- is this scoped how the title implies?`,
      why: 'Scope mismatches are the easiest-to-miss reviewer trap.',
      evidence: 'title language vs diff size',
    });
  }

  if (
    prDescription &&
    !/\bhow|risk|test|rollback|deploy|migration|flag\b/i.test(prDescription) &&
    files.length > 3
  ) {
    out.push({
      topic: 'description',
      question:
        'The PR description does not mention testing, risk, rollback, or migration steps. Can we add a “How to verify” and “Rollback” section?',
      why: 'A short structured description makes review and on-call escalation faster.',
      evidence: 'PR description lacks risk/test/rollback keywords',
    });
  }

  return out;
}

function parseNow(value: string | null) {
  if (value === null) return new Date();
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`\`now\` must be an ISO-8601 timestamp, got ${value}`);
  return new Date(time);
}

function applyOffset(date: Date, offsetMinutes: number) {
  const localMs = date.getTime() + offsetMinutes * 60_000;
  const local = new Date(localMs);
  const hour = local.getUTCHours();
  const weekday = local.getUTCDay();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const iso = local.toISOString().replace('Z', `${sign}${hh}:${mm}`);
  return { hour, weekday, iso };
}

function buildTiming(
  now: Date,
  offsetMinutes: number,
  riskScore: number | null,
  oncall: boolean | null,
  freeze: boolean | null,
) {
  const { hour, weekday, iso } = applyOffset(now, offsetMinutes);
  const factors: Array<{ factor: string; weight: number; recommendation: string }> = [];

  if (freeze === true)
    factors.push({
      factor: 'code freeze in effect',
      weight: -60,
      recommendation:
        'Hold the deploy until the freeze window closes or get an explicit exception.',
    });
  if (weekday === 5 && hour >= 14)
    factors.push({
      factor: 'late Friday',
      weight: -25,
      recommendation: 'Defer to Monday morning unless the change is itself reverting an outage.',
    });
  else if (weekday === 0 || weekday === 6)
    factors.push({
      factor: 'weekend',
      weight: -20,
      recommendation: 'Weekend deploys have thin coverage -- defer or page in extra reviewers.',
    });
  if (hour < 7 || hour >= 22)
    factors.push({
      factor: 'outside core hours',
      weight: -10,
      recommendation: 'Out-of-hours deploys delay rollback if anything regresses.',
    });
  else if (hour >= 9 && hour <= 15)
    factors.push({
      factor: 'within core hours',
      weight: 8,
      recommendation: 'Core hours have the broadest reviewer + on-call coverage.',
    });
  if (oncall === false)
    factors.push({
      factor: 'on-call not available',
      weight: -20,
      recommendation: 'Confirm an on-call before shipping; otherwise hold.',
    });
  else if (oncall === true)
    factors.push({
      factor: 'on-call present',
      weight: 6,
      recommendation: 'On-call coverage in place -- proceed with normal deploy gating.',
    });

  if (riskScore !== null) {
    if (riskScore >= 75)
      factors.push({
        factor: 'critical risk score',
        weight: -30,
        recommendation:
          'Split the change, ship behind a flag, or schedule for a low-traffic window.',
      });
    else if (riskScore >= 50)
      factors.push({
        factor: 'high risk score',
        weight: -15,
        recommendation: 'Pair the deploy with active monitoring of relevant dashboards.',
      });
    else if (riskScore <= 15)
      factors.push({
        factor: 'low risk score',
        weight: 8,
        recommendation: 'Risk profile supports a normal-cadence deploy.',
      });
  }

  const score = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const verdict: TimingVerdict = score <= -25 ? 'hold' : score < 0 ? 'caution' : 'go';
  const summary =
    verdict === 'go'
      ? 'Conditions look good. Proceed with normal deploy gating.'
      : verdict === 'caution'
        ? 'Some headwinds. Proceed only with the recommended mitigations applied.'
        : 'Hold the deploy. The combined factors below outweigh the upside of shipping now.';

  return {
    verdict,
    score,
    local_time: iso,
    local_weekday: WEEKDAY_NAMES[weekday]!,
    factors: factors.sort((a, b) => a.weight - b.weight),
    summary,
  };
}

function buildRollback(
  migrations: string[],
  destructive: boolean | null,
  flags: string[],
  flagDefaultOff: boolean | null,
  externalDeps: boolean | null,
  breakingApi: boolean | null,
  dataMigration: boolean | null,
) {
  const blockers: Array<{ factor: string; severity: 'low' | 'medium' | 'high'; detail: string }> =
    [];
  const reversible: string[] = [];
  let score = 100;

  if (destructive === true) {
    blockers.push({
      factor: 'destructive migration',
      severity: 'high',
      detail: 'Migration drops or rewrites data irreversibly -- a true one-way door.',
    });
    score -= 70;
  } else if (migrations.length > 0) {
    blockers.push({
      factor: 'schema migration',
      severity: 'medium',
      detail: `${migrations.length} migration(s) included; rollback requires a forward fix or a tested down-migration.`,
    });
    score -= 25;
  }

  if (dataMigration === true) {
    blockers.push({
      factor: 'data migration',
      severity: 'high',
      detail: 'Data has been rewritten -- reverting code does not restore the prior data shape.',
    });
    score -= 30;
  }

  if (breakingApi === true) {
    blockers.push({
      factor: 'breaking API change',
      severity: 'high',
      detail: 'External consumers may have already adopted the new contract; rollback breaks them.',
    });
    score -= 25;
  }

  if (externalDeps === true) {
    blockers.push({
      factor: 'external dependency change',
      severity: 'low',
      detail:
        'Lockfile / package update means the rollback build needs the prior pin pulled fresh.',
    });
    score -= 8;
  }

  if (flags.length > 0) {
    if (flagDefaultOff === true) {
      reversible.push(
        `${flags.length} feature flag(s) introduced default-off -- toggle is a no-deploy rollback path.`,
      );
      score += 10;
    } else {
      reversible.push(
        `${flags.length} feature flag(s) modified -- confirm each can be flipped at runtime.`,
      );
    }
  }

  score = Math.max(0, Math.min(100, score));
  const level =
    destructive === true || dataMigration === true
      ? 'one_way_door'
      : score >= 80
        ? 'easy'
        : score >= 50
          ? 'moderate'
          : 'hard';

  const steps = ['Identify the deploy artifact (commit SHA, image tag, or release ID).'];
  if (flags.length > 0 && flagDefaultOff === true)
    steps.push('First, toggle the relevant feature flag(s) off and verify recovery.');
  if (migrations.length > 0 || dataMigration === true)
    steps.push(
      'Decide between revert-with-down-migration and forward-fix; document the decision in the incident channel.',
    );
  if (breakingApi === true)
    steps.push('Notify downstream consumers before reverting, or ship a compatibility shim.');
  if (externalDeps === true)
    steps.push(
      'Re-run the install/build with the prior lockfile to reproduce the previous artifact.',
    );
  steps.push('Watch service-level dashboards for at least one full request cycle after rollback.');

  return {
    score,
    level,
    blockers,
    reversible_changes: reversible,
    recommended_runbook_steps: steps,
  };
}

export function createChangeExplainerTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Turn a unified diff into release notes, an internal changelog, and a reviewer walkthrough.',
    inputSchema: z.object({
      diff: z.string().min(1),
      audience: z
        .enum(['release_notes', 'internal_changelog', 'reviewer_walkthrough', 'all'])
        .optional()
        .default('all'),
      tone: z.string().optional(),
      project_name: z.string().optional(),
      pr_title: z.string().optional(),
      max_walkthrough_steps: z.number().int().positive().max(MAX_STEPS).optional(),
    }),
    execute: async ({
      diff,
      audience = 'all',
      tone,
      project_name,
      pr_title,
      max_walkthrough_steps,
    }) => {
      ensureDiff(diff);
      const files = parseUnifiedDiff(diff);
      const totals = totalLineChanges(files);
      const maxSteps = Math.min(MAX_STEPS, Math.max(1, max_walkthrough_steps ?? DEFAULT_MAX_STEPS));

      return {
        audience,
        tone: tone ?? null,
        files_changed: files.length,
        additions: totals.additions,
        deletions: totals.deletions,
        release_notes:
          audience === 'all' || audience === 'release_notes'
            ? buildReleaseNotes(files, pr_title ?? null, project_name ?? null)
            : null,
        internal_changelog:
          audience === 'all' || audience === 'internal_changelog'
            ? buildInternalChangelog(files)
            : null,
        reviewer_walkthrough:
          audience === 'all' || audience === 'reviewer_walkthrough'
            ? buildWalkthrough(files, maxSteps)
            : null,
      };
    },
  });
}

export function createPrReviewAnalyzerTool(_: ToolFactoryOptions) {
  return tool({
    description: 'Analyze a PR diff and return a deploy risk score plus reviewer-style questions.',
    inputSchema: z.object({
      diff: z.string().min(1),
      pr_title: z.string().optional(),
      pr_description: z.string().optional(),
      coverage_delta_pct: z.number().optional(),
      historical_bug_density: z.record(z.string(), z.number().int().nonnegative()).optional(),
      mode: z.enum(['risk', 'reviewer_questions', 'both']).optional().default('both'),
      max_questions: z.number().int().positive().max(MAX_QUESTIONS).optional(),
    }),
    execute: async ({
      diff,
      pr_title,
      pr_description,
      coverage_delta_pct,
      historical_bug_density,
      mode = 'both',
      max_questions,
    }) => {
      ensureDiff(diff);
      const files = parseUnifiedDiff(diff);
      const totals = totalLineChanges(files);
      const added = joinAddedLines(files);
      const bugDensity = new Map(Object.entries(historical_bug_density ?? {}));
      const maxQuestions = Math.min(
        MAX_QUESTIONS,
        Math.max(1, max_questions ?? DEFAULT_MAX_QUESTIONS),
      );

      return {
        mode,
        files_changed: files.length,
        risk:
          mode === 'reviewer_questions'
            ? null
            : scoreRisk(files, added, totals, coverage_delta_pct ?? null, bugDensity),
        reviewer_questions:
          mode === 'risk'
            ? null
            : buildQuestions(files, added, pr_title ?? null, pr_description ?? null).slice(
                0,
                maxQuestions,
              ),
      };
    },
  });
}

export function createDeploySafetyAdvisorTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Combine change risk and operational context into deploy timing and rollback guidance.',
    inputSchema: z.object({
      risk_score: z.number().min(0).max(100).optional(),
      risk_summary: z.string().optional(),
      now: z.string().optional(),
      timezone_offset_minutes: z.number().int().optional(),
      oncall_present: z.boolean().optional(),
      freeze_window: z.boolean().optional(),
      team: z.string().optional(),
      migrations: z.array(z.string()).optional(),
      destructive_migration: z.boolean().optional(),
      feature_flags: z.array(z.string()).optional(),
      flag_default_off: z.boolean().optional(),
      external_dependency_change: z.boolean().optional(),
      breaking_api_change: z.boolean().optional(),
      has_data_migration: z.boolean().optional(),
      mode: z.enum(['timing', 'rollback', 'both']).optional().default('both'),
    }),
    execute: async ({
      risk_score,
      now,
      timezone_offset_minutes,
      oncall_present,
      freeze_window,
      migrations = [],
      destructive_migration,
      feature_flags = [],
      flag_default_off,
      external_dependency_change,
      breaking_api_change,
      has_data_migration,
      mode = 'both',
    }) => {
      const date = parseNow(now ?? null);
      const offset = timezone_offset_minutes ?? 0;
      return {
        mode,
        timing:
          mode === 'rollback'
            ? null
            : buildTiming(
                date,
                offset,
                risk_score ?? null,
                oncall_present ?? null,
                freeze_window ?? null,
              ),
        rollback:
          mode === 'timing'
            ? null
            : buildRollback(
                migrations,
                destructive_migration ?? null,
                feature_flags,
                flag_default_off ?? null,
                external_dependency_change ?? null,
                breaking_api_change ?? null,
                has_data_migration ?? null,
              ),
      };
    },
  });
}
