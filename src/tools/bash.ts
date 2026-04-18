import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import { EntryKind } from '@/types';
import type { ToolFactoryOptions } from './types';

export function createBashTool({ persistEntry, runUserShell }: ToolFactoryOptions) {
  return tool({
    description: 'Run a shell command',
    inputSchema: z.object({ cmd: z.string() }),
    execute: async ({ cmd }) => {
      persistEntry(EntryKind.Shell, cmd);

      try {
        const { output, exitCode } = await runUserShell(cmd);
        const trimmed = plain(output).trimEnd();
        if (trimmed) return trimmed.slice(0, 4000);
        if (exitCode === 0) return '(no output)';
        return `error: command exited with code ${exitCode}`;
      } catch (error: unknown) {
        return `error: ${plain(error instanceof Error ? error.message : String(error))}`;
      }
    }
  });
}
