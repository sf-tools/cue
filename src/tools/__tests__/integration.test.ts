import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

import { createTools, type ToolFactoryOptions } from '../index';
import type {
  ApprovalRequest,
  ChoiceRequest,
  ChoiceSelection,
  ShellResult,
} from '@/types';

function realOptions(): ToolFactoryOptions {
  return {
    runUserShell: async (cmd: string): Promise<ShellResult> => {
      const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
      return { exitCode: result.status ?? 0, output: `${result.stdout}${result.stderr}` };
    },
    requestApproval: async (_request: ApprovalRequest) => true,
    requestChoice: async (request: ChoiceRequest): Promise<ChoiceSelection> => ({
      ...(request.options[0] ?? { value: '', label: '' }),
      index: 0,
    }),
    setPlanningMode: () => {},
    getPlanningMode: () => false,
    getCurrentModel: () => 'test-model',
    getThinkingMode: () => 'auto' as never,
    pushUndoEntry: () => {},
    peekUndoEntry: () => null,
    popUndoEntry: () => null,
  };
}

type ToolWithExecute = {
  execute: (input: unknown, ctx: unknown) => unknown;
};

const ctx = {
  toolCallId: 'test-call',
  messages: [],
};

async function call<T>(tool: unknown, input: unknown): Promise<T> {
  return (await (tool as ToolWithExecute).execute(input, ctx)) as T;
}

describe('Tier 1 tools — end-to-end against the live repo', () => {
  const tools = createTools(realOptions());

  test('map_codebase recognizes Cue itself', async () => {
    type R = {
      total_files: number;
      ecosystems: string[];
      subsystems: Array<{ path: string; role: string; file_count: number }>;
      entrypoints: Array<{ path: string; kind: string }>;
      configs: Array<{ path: string; kind: string }>;
      docs: string[];
      summary: string;
    };
    const result = await call<R>(tools.map_codebase, {
      max_subsystems: 8,
      max_files_per_subsystem: 3,
    });

    expect(result.total_files).toBeGreaterThan(20);
    expect(result.ecosystems).toContain('node');
    expect(result.subsystems.some(s => s.path === 'src')).toBe(true);
    expect(result.subsystems.some(s => s.path === 'src/tools')).toBe(true);
    expect(result.subsystems.some(s => s.path === 'src/agent')).toBe(true);
    expect(result.entrypoints.some(e => e.kind === 'bin')).toBe(true);
    expect(result.entrypoints.some(e => e.kind === 'main')).toBe(true);
    expect(result.configs.some(c => c.kind === 'typescript')).toBe(true);
    expect(result.configs.some(c => c.kind === 'package')).toBe(true);
    expect(result.docs.some(doc => /readme/i.test(doc))).toBe(true);
    expect(result.summary.length).toBeGreaterThan(50);
  });

  test('plan_change produces a coherent plan for a Cue-flavored goal', async () => {
    type R = {
      intent: string;
      risk: 'low' | 'medium' | 'high';
      scope: 'narrow' | 'medium' | 'wide';
      files: Array<{ path: string; kind: string; edit_kind: string }>;
      test_files: string[];
      steps: Array<{ phase: string; action: string }>;
      open_questions: string[];
      rollback_strategy: string;
    };
    const result = await call<R>(tools.plan_change, {
      goal: 'Add a new tool called codebase_qa_v2 that reuses the codebase_qa search pipeline',
      target_files: ['src/tools/diagnose.ts', 'src/tools/index.ts'],
      hint_files: ['src/tools/types.ts'],
    });

    expect(result.intent).toBe('feature');
    expect(['narrow', 'medium', 'wide']).toContain(result.scope);
    expect(result.files.length).toBeGreaterThanOrEqual(3);
    expect(result.test_files).toContain('src/tools/diagnose.test.ts');
    expect(result.steps.some(step => step.phase === 'verify')).toBe(true);
    expect(result.steps.some(step => step.phase === 'review')).toBe(true);
    expect(result.rollback_strategy.length).toBeGreaterThan(0);
  });

  test('policy_guard blocks rm -rf ~ and allows benign read', async () => {
    type R = {
      verdict: 'allow' | 'warn' | 'block';
      risk: 'low' | 'medium' | 'high' | 'critical';
      reasons: Array<{ rule: string; severity: string }>;
      mitigations: string[];
      summary: string;
    };

    const danger = await call<R>(tools.policy_guard, {
      action: 'command',
      target: 'rm -rf ~',
    });
    expect(danger.verdict).toBe('block');
    expect(danger.risk).toBe('critical');
    expect(danger.summary.toLowerCase()).toContain('block');

    const benign = await call<R>(tools.policy_guard, {
      action: 'read',
      target: 'src/tools/index.ts',
    });
    expect(benign.verdict).toBe('allow');
    expect(benign.risk).toBe('low');

    const userRule = await call<R>(tools.policy_guard, {
      action: 'command',
      target: 'helm upgrade prod-cluster',
      user_rules: ['block:helm upgrade prod'],
    });
    expect(userRule.verdict).toBe('block');
  });

  test('issue_to_fix_plan finds suspect files in this repo', async () => {
    type R = {
      extracted_terms: string[];
      likely_files: Array<{
        path: string;
        score: number;
        matched_terms: string[];
        snippet: string;
      }>;
      plan: {
        symptoms: string[];
        hypothesis: string;
        diagnose: string[];
        reproduce: string[];
        fix: string[];
      };
    };
    const result = await call<R>(tools.issue_to_fix_plan, {
      issue:
        'The buildCodebaseMap function returns the wrong subsystem count when called with truncated file lists.',
      max_files: 5,
    });
    expect(result.extracted_terms.length).toBeGreaterThan(0);
    expect(result.likely_files.length).toBeGreaterThan(0);
    expect(
      result.likely_files.some(item => /map-codebase\.ts$/.test(item.path)),
    ).toBe(true);
    expect(result.plan.symptoms.length).toBeGreaterThan(0);
    expect(result.plan.hypothesis.length).toBeGreaterThan(0);
  });

  test('log_trace_to_code maps a runtime log to source files', async () => {
    type R = {
      log_signals: string[];
      extracted_terms: string[];
      likely_files: Array<{ path: string; matched_terms: string[] }>;
    };
    const result = await call<R>(tools.log_trace_to_code, {
      logs:
        '2025-09-12T18:01:23Z ERROR could not parseUnifiedDiff: TypeError: Cannot read properties of undefined (reading \'addedLines\')',
      max_files: 5,
    });
    expect(result.log_signals.length).toBeGreaterThan(0);
    expect(result.likely_files.length).toBeGreaterThan(0);
    expect(
      result.likely_files.some(item => /diff-analysis\.ts$/.test(item.path)),
    ).toBe(true);
  });
});
