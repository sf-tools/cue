import { readFile } from 'node:fs/promises';

import { tool } from 'ai';
import { z } from 'zod';

import { EntryKind } from '@/agent/types';
import type { ToolFactoryOptions } from './types';

export function createReadTool({ persistEntry }: ToolFactoryOptions) {
  return tool({
    description: 'Read a file from disk',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      persistEntry(EntryKind.Tool, `read(${path})`);
      return await readFile(path, 'utf8');
    }
  });
}
