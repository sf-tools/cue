import { tool } from 'ai';
import { z } from 'zod';

import type { ToolFactoryOptions } from './types';
import { classifyPath, type FileKind } from './diff-analysis';

export type ChangeIntent =
  | 'feature'
  | 'fix'
  | 'refactor'
  | 'performance'
  | 'docs'
  | 'tests'
  | 'security'
  | 'cleanup'
  | 'config'
  | 'unknown';

export type PlanRisk = 'low' | 'medium' | 'high';

export type PlanStep = {
  order: number;
  phase: 'context' | 'design' | 'implement' | 'verify' | 'review';
  action: string;
  why: string;
};

export type PlanFileTouch = {
  path: string;
  kind: FileKind;
  reason: string;
  edit_kind: 'create' | 'modify' | 'inspect' | 'rename' | 'delete';
};

export type PlanChangeResult = {
  goal: string;
  intent: ChangeIntent;
  scope: 'narrow' | 'medium' | 'wide';
  risk: PlanRisk;
  risk_drivers: string[];
  files: PlanFileTouch[];
  test_files: string[];
  steps: PlanStep[];
  open_questions: string[];
  rollback_strategy: string;
  constraints: string[];
};

const MAX_FILES_INPUT = 50;
const MAX_CONSTRAINTS = 20;

const INTENT_KEYWORDS: Array<{ intent: ChangeIntent; pattern: RegExp; weight: number }> = [
  { intent: 'fix', pattern: /\b(fix|bug|broken|regression|crash|error|leak|hang|stuck)\b/i, weight: 3 },
  { intent: 'feature', pattern: /\b(add|introduce|implement|new|support|enable|build)\b/i, weight: 2 },
  { intent: 'refactor', pattern: /\b(refactor|simplify|extract|rename|reorganize|move|restructure)\b/i, weight: 3 },
  { intent: 'performance', pattern: /\b(perf|performance|optimi[sz]e|speed up|faster|latency|throughput|cache)\b/i, weight: 3 },
  { intent: 'security', pattern: /\b(security|auth|authn|authz|permission|secret|leak|cve|vulnerability|sanitize)\b/i, weight: 3 },
  { intent: 'docs', pattern: /\b(docs?|documentation|readme|guide|comment)\b/i, weight: 3 },
  { intent: 'tests', pattern: /\b(test|coverage|assert|spec|fixture|mock)\b/i, weight: 3 },
  { intent: 'cleanup', pattern: /\b(cleanup|clean[- ]?up|remove|delete|drop|deprecate|prune|unused|dead code)\b/i, weight: 4 },
  { intent: 'config', pattern: /\b(config|setting|env|environment|toggle|flag)\b/i, weight: 2 },
];

function inferIntent(goal: string): ChangeIntent {
  const tally = new Map<ChangeIntent, number>();
  for (const { intent, pattern, weight } of INTENT_KEYWORDS) {
    if (pattern.test(goal)) tally.set(intent, (tally.get(intent) ?? 0) + weight);
  }
  let best: ChangeIntent = 'unknown';
  let bestScore = 0;
  for (const [intent, score] of tally) {
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  return bestScore > 0 ? best : 'unknown';
}

function determineScope(touched: number, intent: ChangeIntent): PlanChangeResult['scope'] {
  if (touched >= 12) return 'wide';
  if (touched >= 4) return 'medium';
  if (intent === 'refactor' && touched >= 2) return 'medium';
  return 'narrow';
}

function intentToTestPattern(intent: ChangeIntent) {
  switch (intent) {
    case 'fix':
      return 'Add a regression test that fails before the fix and passes after.';
    case 'feature':
      return 'Add behavior tests for the new path; cover happy path + at least one error case.';
    case 'refactor':
      return 'Lock current behavior in tests before refactoring; prefer characterization tests.';
    case 'performance':
      return 'Add a perf-sensitive benchmark or assert big-O via test data sizing.';
    case 'security':
      return 'Add a negative-path test that proves the bad input is rejected.';
    case 'docs':
      return 'Run doc/example smoke tests; render markdown locally.';
    case 'tests':
      return 'Confirm tests run in CI; consider whether the assertion really pins the behavior.';
    case 'cleanup':
      return 'After removal, ensure no dangling references and run the full test suite.';
    case 'config':
      return 'Verify each environment has the new config; document defaults.';
    default:
      return 'Add tests that pin the behavior of every changed code path.';
  }
}

function suggestedTestPath(file: string): string | null {
  if (/\.test\.[jt]sx?$|\.spec\.[jt]sx?$/.test(file)) return null;
  if (/_test\.go$|_test\.py$/.test(file)) return null;
  if (/(^|\/)tests?\//.test(file) || /__tests__/.test(file)) return null;

  if (/\.tsx?$/.test(file)) return file.replace(/\.tsx?$/, match => `.test${match}`);
  if (/\.jsx?$/.test(file)) return file.replace(/\.jsx?$/, match => `.test${match}`);
  if (/\.py$/.test(file)) {
    const parts = file.split('/');
    const last = parts.pop()!;
    return [...parts, `test_${last}`].join('/');
  }
  if (/\.go$/.test(file)) return file.replace(/\.go$/, '_test.go');
  if (/\.rs$/.test(file)) return null;
  return null;
}

function riskDrivers(touches: PlanFileTouch[], intent: ChangeIntent, constraints: string[]) {
  const drivers: string[] = [];
  const kinds = new Set(touches.map(item => item.kind));
  if (kinds.has('migration')) drivers.push('schema migration touched');
  if (kinds.has('security')) drivers.push('security-sensitive path touched');
  if (kinds.has('infra') || kinds.has('ci')) drivers.push('infra / CI touched');
  if (kinds.has('deps') || kinds.has('lockfile')) drivers.push('dependency manifest changed');
  if (touches.some(touch => touch.edit_kind === 'delete')) drivers.push('file deletion proposed');
  if (touches.some(touch => touch.edit_kind === 'rename')) drivers.push('file rename proposed');
  if (touches.length >= 12) drivers.push('wide blast radius (12+ files)');
  if (intent === 'security') drivers.push('explicit security intent');
  if (intent === 'performance') drivers.push('performance work — measure before & after');
  for (const constraint of constraints) {
    if (/migration|production|prod\b|public api|breaking/i.test(constraint)) {
      drivers.push(`constraint: ${constraint}`);
    }
  }
  return drivers;
}

function pickRisk(drivers: string[], scope: PlanChangeResult['scope']): PlanRisk {
  if (drivers.length === 0) return scope === 'wide' ? 'medium' : 'low';
  const high = drivers.some(driver =>
    /migration|security|public api|breaking|infra|ci|deletion/i.test(driver),
  );
  if (high) return 'high';
  if (drivers.length >= 2 || scope !== 'narrow') return 'medium';
  return 'low';
}

function buildSteps(
  intent: ChangeIntent,
  touches: PlanFileTouch[],
  testFiles: string[],
  scope: PlanChangeResult['scope'],
): PlanStep[] {
  const steps: PlanStep[] = [];
  let order = 1;

  steps.push({
    order: order++,
    phase: 'context',
    action: 'Read each touched file end-to-end and trace its public surface.',
    why: 'Avoid breaking implicit contracts by editing without context.',
  });

  if (touches.some(touch => touch.kind === 'src')) {
    steps.push({
      order: order++,
      phase: 'context',
      action: 'Trace inbound callers of the source files (ripgrep + LSP references).',
      why: 'Knowing the callers prevents accidental contract changes.',
    });
  }

  steps.push({
    order: order++,
    phase: 'design',
    action: 'Decide the smallest change that achieves the goal; sketch the diff before editing.',
    why: 'Smallest viable edit minimizes review and rollback risk.',
  });

  if (intent === 'refactor' || intent === 'performance' || scope !== 'narrow') {
    steps.push({
      order: order++,
      phase: 'design',
      action: 'Lock current behavior in tests before changing implementation.',
      why: 'Characterization tests catch silent regressions during a rewrite.',
    });
  }

  steps.push({
    order: order++,
    phase: 'implement',
    action: `Apply edits across ${touches.length} file(s) in a single logical change set.`,
    why: 'Coherent commits are easier to review, revert, and bisect.',
  });

  if (testFiles.length > 0) {
    steps.push({
      order: order++,
      phase: 'verify',
      action: `Add or update ${testFiles.length} test file(s); ${intentToTestPattern(intent)}`,
      why: 'Tests close the loop and prove the change.',
    });
  } else {
    steps.push({
      order: order++,
      phase: 'verify',
      action: `${intentToTestPattern(intent)} (no test files inferred — pick one explicitly).`,
      why: 'Tests close the loop and prove the change.',
    });
  }

  steps.push({
    order: order++,
    phase: 'verify',
    action: 'Run change-aware verification (typecheck + targeted tests + lint) before review.',
    why: 'Verifying locally avoids round-tripping through CI.',
  });

  steps.push({
    order: order++,
    phase: 'review',
    action: 'Self-review the diff: scope, naming, error handling, observability, public-API impact.',
    why: 'Reviewers will ask these questions; pre-empt them.',
  });

  return steps;
}

function buildOpenQuestions(touches: PlanFileTouch[], intent: ChangeIntent): string[] {
  const out: string[] = [];
  if (intent === 'unknown') {
    out.push('What is the precise success criterion (user-visible behavior change)?');
  }
  if (touches.some(touch => touch.kind === 'security')) {
    out.push('Which threat model assumptions does this change rely on?');
  }
  if (touches.some(touch => touch.kind === 'migration')) {
    out.push('Is this migration backward-compatible during a rolling deploy?');
  }
  if (touches.some(touch => touch.kind === 'infra')) {
    out.push('Has the infra change been tested against staging before production?');
  }
  if (touches.some(touch => touch.edit_kind === 'rename')) {
    out.push('Are there string-based references to the old name (configs, docs, logs)?');
  }
  if (touches.some(touch => touch.edit_kind === 'delete')) {
    out.push('Are there callers (including tests, fixtures, or external consumers) we must update?');
  }
  if (touches.length === 0) {
    out.push('Which files actually need to change to deliver this goal?');
  }
  return out;
}

function rollbackStrategy(touches: PlanFileTouch[], intent: ChangeIntent) {
  const kinds = new Set(touches.map(item => item.kind));
  if (kinds.has('migration')) {
    return 'Migrations are not freely reversible — write the down-migration with the up, and gate the code on a feature flag if possible.';
  }
  if (kinds.has('infra') || kinds.has('ci')) {
    return 'Keep the prior infra/CI config as a separate revertable commit; deploy in a staging environment first.';
  }
  if (intent === 'feature') {
    return 'Ship behind a feature flag default-off so rollback is a no-deploy toggle.';
  }
  if (intent === 'security' || intent === 'fix') {
    return 'Land as a tight commit; if regressions appear, revert the commit and re-derive a smaller fix.';
  }
  return 'Land as a single logical commit; rollback is `git revert` on that commit.';
}

export function planChange(input: {
  goal: string;
  target_files?: string[];
  hint_files?: string[];
  scope_hint?: 'narrow' | 'medium' | 'wide';
  constraints?: string[];
}): PlanChangeResult {
  const goal = input.goal.trim();
  if (!goal) throw new Error('goal must be a non-empty string');

  const constraints = (input.constraints ?? []).slice(0, MAX_CONSTRAINTS);
  const targetFiles = (input.target_files ?? []).slice(0, MAX_FILES_INPUT);
  const hintFiles = (input.hint_files ?? []).slice(0, MAX_FILES_INPUT);

  const intent = inferIntent(goal);
  const seen = new Set<string>();
  const touches: PlanFileTouch[] = [];
  for (const file of targetFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    const kind = classifyPath(file);
    touches.push({
      path: file,
      kind,
      reason: 'declared as target',
      edit_kind: 'modify',
    });
  }
  for (const file of hintFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    const kind = classifyPath(file);
    touches.push({
      path: file,
      kind,
      reason: 'inferred neighbor / suggested touch point',
      edit_kind: kind === 'test' ? 'modify' : 'inspect',
    });
  }

  const scope =
    input.scope_hint ??
    determineScope(
      touches.filter(touch => touch.edit_kind !== 'inspect').length,
      intent,
    );

  const testFiles: string[] = [];
  for (const touch of touches) {
    if (touch.kind === 'test') testFiles.push(touch.path);
    else {
      const guess = suggestedTestPath(touch.path);
      if (guess && !testFiles.includes(guess)) testFiles.push(guess);
    }
  }

  const drivers = riskDrivers(touches, intent, constraints);
  const risk = pickRisk(drivers, scope);
  const steps = buildSteps(intent, touches, testFiles, scope);
  const openQuestions = buildOpenQuestions(touches, intent);
  const rollback = rollbackStrategy(touches, intent);

  return {
    goal,
    intent,
    scope,
    risk,
    risk_drivers: drivers,
    files: touches,
    test_files: testFiles,
    steps,
    open_questions: openQuestions,
    rollback_strategy: rollback,
    constraints,
  };
}

export function createPlanChangeTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Build a change plan from a natural-language goal: intent, scope, risk, files, tests, ordered steps, and rollback strategy. Pure logic — call before editing.',
    inputSchema: z.object({
      goal: z.string().min(1),
      target_files: z.array(z.string()).max(MAX_FILES_INPUT).optional(),
      hint_files: z.array(z.string()).max(MAX_FILES_INPUT).optional(),
      scope_hint: z.enum(['narrow', 'medium', 'wide']).optional(),
      constraints: z.array(z.string()).max(MAX_CONSTRAINTS).optional(),
    }),
    execute: async ({ goal, target_files, hint_files, scope_hint, constraints }) =>
      planChange({
        goal,
        target_files: target_files ?? undefined,
        hint_files: hint_files ?? undefined,
        scope_hint: scope_hint ?? undefined,
        constraints: constraints ?? undefined,
      }),
  });
}
