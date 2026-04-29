import { describe, expect, test } from 'bun:test';

import { createTools, type ToolFactoryOptions } from '../index';
import type { ShellResult, ApprovalRequest, ChoiceRequest, ChoiceSelection } from '@/types';

function noopOptions(): ToolFactoryOptions {
  return {
    runUserShell: async (): Promise<ShellResult> => ({ exitCode: 0, output: '' }),
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

describe('createTools registry', () => {
  test('exposes the new Tier 1 tools alongside existing ones', () => {
    const tools = createTools(noopOptions());

    expect(tools.map_codebase).toBeDefined();
    expect(tools.plan_change).toBeDefined();
    expect(tools.policy_guard).toBeDefined();
    expect(tools.issue_to_fix_plan).toBeDefined();
    expect(tools.log_trace_to_code).toBeDefined();

    expect(tools.bash_bg).toBeDefined();
    expect(tools.bash_output).toBeDefined();
    expect(tools.bash_kill).toBeDefined();
    expect(tools.verify_changes).toBeDefined();
    expect(tools.change_explainer).toBeDefined();
    expect(tools.pr_review_analyzer).toBeDefined();
    expect(tools.deploy_safety_advisor).toBeDefined();
    expect(tools.stacktrace_to_root_cause).toBeDefined();
  });

  test('each new tool has description and inputSchema', () => {
    const tools = createTools(noopOptions());
    for (const name of [
      'map_codebase',
      'plan_change',
      'policy_guard',
      'issue_to_fix_plan',
      'log_trace_to_code',
    ] as const) {
      const t = tools[name] as { description?: unknown; inputSchema?: unknown };
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toBeDefined();
    }
  });
});
