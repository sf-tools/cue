import { tool } from 'ai';
import { z } from 'zod';

import type { ToolFactoryOptions } from './types';

const planningModeSchema = z.object({
  mode: z.enum(['on', 'off', 'status']).default('status'),
});

export function createPlanningModeTool({ getPlanningMode, setPlanningMode }: ToolFactoryOptions) {
  return tool({
    description:
      'Enable or disable planning mode. In planning mode, the agent should stay read-only, focus on discovery/tradeoffs, and produce plans instead of making edits. Use this when the user wants planning first or wants to avoid file changes for now.',
    inputSchema: planningModeSchema,
    execute: async ({ mode = 'status' }) => {
      const current = getPlanningMode();
      const next = mode === 'status' ? current : mode === 'on';
      const changed = mode !== 'status' && next !== current;

      if (mode !== 'status') setPlanningMode(next);

      return {
        planningMode: next,
        changed,
        message:
          mode === 'status'
            ? `planning mode is ${current ? 'on' : 'off'}`
            : `planning mode ${changed ? (next ? 'enabled' : 'disabled') : 'unchanged'}`,
      };
    },
  });
}
