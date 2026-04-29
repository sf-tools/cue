import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';

const MAX_TEXT_LENGTH = 200_000;
const DEFAULT_MAX_FILES = 8;
const HARD_MAX_FILES = 25;
const MAX_TERMS = 12;
const MAX_HITS_PER_TERM = 6;
const SNIPPET_CONTEXT = 3;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'not',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'why',
  'will',
  'with',
  'work',
  'works',
  'working',
  'broke',
  'broken',
  'bug',
  'issue',
  'when',
]);

type Hit = {
  file: string;
  line: number;
  text: string;
};

type Cluster = {
  file: string;
  hits: Hit[];
  matchedTerms: Set<string>;
  score: number;
  snippet?: string;
};

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function extractTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  const quoted = text.matchAll(/["'`]([^"'`]+)["'`]/g);
  for (const match of quoted) {
    const value = match[1]!.trim();
    if (value && !seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      terms.push(value);
    }
  }

  const symbol = text.matchAll(/\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*)\b/g);
  for (const match of symbol) {
    const value = match[1]!;
    if (!seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      terms.push(value);
    }
  }

  const dottedPath = text.matchAll(/\b([a-zA-Z_][\w]*\.[\w.]{2,})\b/g);
  for (const match of dottedPath) {
    const value = match[1]!;
    if (!seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      terms.push(value);
    }
  }

  const filePaths = text.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|sql)/g);
  for (const match of filePaths) {
    const value = match[0]!;
    if (!seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      terms.push(value);
    }
  }

  const errorPhrases = text.matchAll(
    /\b(?:Error|Exception|Failed|Cannot|Unable|Undefined|Null|Timeout)[^.\n]{3,80}/g,
  );
  for (const match of errorPhrases) {
    const value = match[0]!.trim();
    if (!seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      terms.push(value);
    }
  }

  const ident = text.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b/g);
  for (const match of ident) {
    const value = match[0]!;
    const lower = value.toLowerCase();
    if (STOP_WORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    terms.push(value);
  }

  return terms.slice(0, MAX_TERMS);
}

async function searchTerm(
  runUserShell: ToolFactoryOptions['runUserShell'],
  term: string,
  root: string,
): Promise<Hit[]> {
  const cmd = `if command -v rg >/dev/null 2>&1; then command rg --line-number --no-heading --color=never --fixed-strings -i ${shellEscape(term)} ${shellEscape(root)}; else command grep -RIn -- ${shellEscape(term)} ${shellEscape(root)}; fi`;
  const { output, exitCode } = await runUserShell(cmd);
  const text = plain(output).trim();
  if (exitCode !== 0 && exitCode !== 1) return [];
  const lines = text.split('\n').filter(Boolean);
  const out: Hit[] = [];
  for (const line of lines) {
    const colonOne = line.indexOf(':');
    if (colonOne === -1) continue;
    const colonTwo = line.indexOf(':', colonOne + 1);
    if (colonTwo === -1) continue;
    const file = line.slice(0, colonOne);
    const lineNo = Number.parseInt(line.slice(colonOne + 1, colonTwo), 10);
    const matchText = line.slice(colonTwo + 1);
    if (!Number.isFinite(lineNo)) continue;
    if (file.includes('node_modules/') || file.includes('/.git/')) continue;
    out.push({ file, line: lineNo, text: matchText.trim() });
    if (out.length >= MAX_HITS_PER_TERM) break;
  }
  return out;
}

async function readSnippet(filePath: string, lineNumber: number) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return '';
  } catch {
    return '';
  }
  const text = await readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, lineNumber - 1 - SNIPPET_CONTEXT);
  const end = Math.min(lines.length, lineNumber + SNIPPET_CONTEXT);
  return lines
    .slice(start, end)
    .map((line, index) => {
      const ln = start + index + 1;
      const marker = ln === lineNumber ? '>' : ' ';
      return `${marker} ${String(ln).padStart(5)}  ${line}`;
    })
    .join('\n');
}

function clusterHits(hitsByTerm: Map<string, Hit[]>, root: string): Cluster[] {
  const clusters = new Map<string, Cluster>();
  let termIndex = 0;
  const totalTerms = hitsByTerm.size || 1;
  for (const [term, hits] of hitsByTerm.entries()) {
    const positionWeight = 1 - termIndex / Math.max(totalTerms, 1);
    for (const hit of hits) {
      const rel = relative(root, resolve(hit.file)) || hit.file;
      const cluster = clusters.get(rel) ?? {
        file: rel,
        hits: [],
        matchedTerms: new Set<string>(),
        score: 0,
      };
      cluster.hits.push({ ...hit, file: rel });
      cluster.matchedTerms.add(term);
      cluster.score += 0.5 + positionWeight;
      clusters.set(rel, cluster);
    }
    termIndex += 1;
  }
  return Array.from(clusters.values()).sort(
    (a, b) =>
      b.score - a.score || b.matchedTerms.size - a.matchedTerms.size || a.file.localeCompare(b.file),
  );
}

async function searchAllTerms(
  runUserShell: ToolFactoryOptions['runUserShell'],
  terms: string[],
  root: string,
) {
  const results = new Map<string, Hit[]>();
  for (const term of terms) {
    const hits = await searchTerm(runUserShell, term, root);
    if (hits.length > 0) results.set(term, hits);
  }
  return results;
}

function topHitsForCluster(cluster: Cluster) {
  return cluster.hits
    .slice()
    .sort((a, b) => a.line - b.line)
    .slice(0, 4);
}

async function attachSnippets(clusters: Cluster[], root: string) {
  await Promise.all(
    clusters.map(async cluster => {
      const lead = cluster.hits[0];
      if (!lead) return;
      cluster.snippet = await readSnippet(resolve(root, cluster.file), lead.line);
    }),
  );
}

function buildIssueFixPlan(
  issue: string,
  clusters: Cluster[],
  reproSteps: string | null,
  environment: string | null,
): {
  symptoms: string[];
  hypothesis: string;
  diagnose: string[];
  reproduce: string[];
  fix: string[];
  test: string[];
  rollout: string[];
} {
  const symptoms: string[] = [];
  if (/\bcrash|panic|segfault\b/i.test(issue)) symptoms.push('process crashes / panics');
  if (/\b(?:slow|timeout|hang)\b/i.test(issue)) symptoms.push('latency / hangs');
  if (/\b(?:wrong|incorrect|bad)\b/i.test(issue)) symptoms.push('incorrect output');
  if (/\b(?:5\d{2}|http error|api error)\b/i.test(issue)) symptoms.push('upstream / API error response');
  if (/\b(?:missing|empty|null|undefined)\b/i.test(issue))
    symptoms.push('missing / nil-shaped data');
  if (symptoms.length === 0) symptoms.push('not yet classified — read the issue end-to-end first');

  const topFile = clusters[0]?.file;
  const hypothesis = topFile
    ? `The bug most likely lives in or near \`${topFile}\` based on the issue text overlap.`
    : 'No code overlap was found yet — extract a more specific symbol or error string and re-run.';

  const diagnose = [
    'Read the full issue text and any linked logs / dashboards before touching code.',
    `Open the top suspects (${clusters
      .slice(0, 3)
      .map(item => `\`${item.file}\``)
      .join(', ') || '— none yet'}) and trace the call sites.`,
    'Confirm whether the symptom is reproducible deterministically or only under load.',
  ];

  const reproduce = [
    reproSteps?.trim()
      ? `Use the supplied repro: ${reproSteps.trim()}`
      : 'Reduce the issue to the smallest input that still triggers it (data + endpoint + flags).',
    'Add a failing automated test that captures the reduced repro before fixing anything.',
    environment?.trim() ? `Match this environment when reproducing: ${environment.trim()}` : 'Match the user-reported environment (versions, flags) when reproducing.',
  ];

  const fix = [
    'Aim for the smallest viable change in the suspect code path.',
    'Resist combining a fix with refactors — they obscure the bisect.',
    'If the fix is non-obvious, leave a code comment explaining the constraint.',
  ];

  const test = [
    'Confirm the new test fails on `main` and passes on the fix branch.',
    'Add at least one negative-path test that proves the bad input is handled.',
    'Run the surrounding test files end-to-end before opening a PR.',
  ];

  const rollout = [
    'Land as a single, revertable commit with a descriptive message.',
    'If the bug had blast radius (data loss, security, paying customer), mention it in the PR description.',
    'Watch the affected dashboards / metrics for at least one full request cycle after deploy.',
  ];

  return { symptoms, hypothesis, diagnose, reproduce, fix, test, rollout };
}

function classifyLogs(logs: string) {
  const out: string[] = [];
  if (/\b(?:OOM|out of memory|MemoryError|JavaScript heap out of memory)\b/i.test(logs)) {
    out.push('memory pressure: process killed by OOM or ran out of heap');
  }
  if (/\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|getaddrinfo ENOTFOUND)\b/.test(logs)) {
    out.push('network: upstream connection failed / DNS issue');
  }
  if (/\b(?:5\d{2})\b/.test(logs)) {
    out.push('upstream returned a 5xx — check downstream health and retry policy');
  }
  if (/\b(?:rate ?limit|429)\b/i.test(logs)) {
    out.push('rate limit or 429 — review backoff and request budget');
  }
  if (/\b(?:Permission denied|EACCES|Forbidden)\b/i.test(logs)) {
    out.push('permission error — verify credentials and IAM roles');
  }
  if (/\b(?:undefined|null|NoneType|TypeError|NullPointerException)\b/i.test(logs)) {
    out.push('null/undefined handling — defensive checks needed at the failure site');
  }
  if (/\b(?:Deadlock|database is locked|too many connections)\b/i.test(logs)) {
    out.push('database contention — check long-running transactions and connection pooling');
  }
  if (out.length === 0) out.push('no canonical patterns matched — rely on extracted terms below');
  return out;
}

export async function runIssueToFixPlan(
  issueInput: string,
  options: {
    root?: string;
    repro_steps?: string;
    environment?: string;
    max_files?: number;
    runUserShell: ToolFactoryOptions['runUserShell'];
  },
) {
  const issue = issueInput.trim();
  if (!issue) throw new Error('issue must be non-empty');
  if (issue.length > MAX_TEXT_LENGTH) {
    throw new Error(`issue is too long (${issue.length} chars); max ${MAX_TEXT_LENGTH}`);
  }
  const root = resolve(options.root ?? '.');
  const maxFiles = Math.min(HARD_MAX_FILES, Math.max(1, options.max_files ?? DEFAULT_MAX_FILES));
  const terms = extractTerms(issue);

  const hitsByTerm = await searchAllTerms(options.runUserShell, terms, root);
  const clusters = clusterHits(hitsByTerm, root).slice(0, maxFiles);
  await attachSnippets(clusters, root);

  const plan = buildIssueFixPlan(
    issue,
    clusters,
    options.repro_steps?.trim() || null,
    options.environment?.trim() || null,
  );

  return {
    issue,
    extracted_terms: terms,
    likely_files: clusters.map(cluster => ({
      path: cluster.file,
      score: Math.round(cluster.score * 100) / 100,
      matched_terms: Array.from(cluster.matchedTerms),
      hits: topHitsForCluster(cluster),
      snippet: cluster.snippet ?? '',
    })),
    plan,
  };
}

export async function runLogTraceToCode(
  logsInput: string,
  options: {
    root?: string;
    hint?: string;
    max_files?: number;
    runUserShell: ToolFactoryOptions['runUserShell'];
  },
) {
  const logs = logsInput.trim();
  if (!logs) throw new Error('logs must be non-empty');
  if (logs.length > MAX_TEXT_LENGTH) {
    throw new Error(`logs are too long (${logs.length} chars); max ${MAX_TEXT_LENGTH}`);
  }

  const root = resolve(options.root ?? '.');
  const maxFiles = Math.min(HARD_MAX_FILES, Math.max(1, options.max_files ?? DEFAULT_MAX_FILES));

  const baseTerms = extractTerms(logs);
  const hintTerms = options.hint ? extractTerms(options.hint) : [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of [...hintTerms, ...baseTerms]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }

  const hitsByTerm = await searchAllTerms(options.runUserShell, terms, root);
  const clusters = clusterHits(hitsByTerm, root).slice(0, maxFiles);
  await attachSnippets(clusters, root);

  return {
    log_signals: classifyLogs(logs),
    extracted_terms: terms,
    likely_files: clusters.map(cluster => ({
      path: cluster.file,
      score: Math.round(cluster.score * 100) / 100,
      matched_terms: Array.from(cluster.matchedTerms),
      hits: topHitsForCluster(cluster),
      snippet: cluster.snippet ?? '',
    })),
  };
}

export function createIssueToFixPlanTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Turn a bug report / issue into likely files plus a structured diagnose-reproduce-fix-test-rollout plan.',
    inputSchema: z.object({
      issue: z.string().min(1),
      root: z.string().nullable().optional(),
      repro_steps: z.string().nullable().optional(),
      environment: z.string().nullable().optional(),
      max_files: z.number().int().positive().max(HARD_MAX_FILES).nullable().optional(),
    }),
    execute: async ({ issue, root, repro_steps, environment, max_files }) =>
      runIssueToFixPlan(issue, {
        root: root ?? undefined,
        repro_steps: repro_steps ?? undefined,
        environment: environment ?? undefined,
        max_files: max_files ?? undefined,
        runUserShell,
      }),
  });
}

export function createLogTraceToCodeTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Map a runtime log excerpt to suspect files. Extracts identifiers / error phrases and ranks code locations that mention them.',
    inputSchema: z.object({
      logs: z.string().min(1),
      root: z.string().nullable().optional(),
      hint: z.string().nullable().optional(),
      max_files: z.number().int().positive().max(HARD_MAX_FILES).nullable().optional(),
    }),
    execute: async ({ logs, root, hint, max_files }) =>
      runLogTraceToCode(logs, {
        root: root ?? undefined,
        hint: hint ?? undefined,
        max_files: max_files ?? undefined,
        runUserShell,
      }),
  });
}

export const _internal = { extractTerms, classifyLogs, buildIssueFixPlan };
