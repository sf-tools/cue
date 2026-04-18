import { writeFile } from 'node:fs/promises';

import { tool } from 'ai';
import { z } from 'zod';

import { EntryKind } from '@/types';
import type { ToolFactoryOptions } from './types';

export function createWriteTool({ persistEntry }: ToolFactoryOptions) {
  return tool({
    description: 'Write content to a file',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      persistEntry(EntryKind.Tool, `write(${path})`);
      await writeFile(path, content);
      return `wrote ${content.length} bytes to ${path}`;
    }
  });
}
