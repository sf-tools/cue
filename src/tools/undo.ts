import { tool } from 'ai';
import { z } from 'zod';

import { applyUndoEntry, buildUndoFileChanges } from '@/undo';
import type { ToolFactoryOptions } from './types';

export function createUndoTool({ requestApproval, peekUndoEntry, popUndoEntry }: ToolFactoryOptions) {
  return tool({
    description: 'Undo the last successful write or edit tool action from this session.',
    inputSchema: z.object({}),
    execute: async () => {
      const entry = peekUndoEntry();
      if (!entry) return 'nothing to undo';

      const fileChanges = await buildUndoFileChanges(entry);
      if (fileChanges.length > 0) {
        const approved = await requestApproval({
          scope: 'edit',
          title: 'Undo last change',
          detail: entry.summary,
          fileChanges
        });

        if (!approved) throw new Error('undo denied by user');
      }

      await applyUndoEntry(entry);
      popUndoEntry();
      return `undid ${entry.summary}`;
    }
  });
}
