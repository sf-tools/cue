import { readFile } from 'node:fs/promises';

import { tool } from 'ai';
import { z } from 'zod';

import type { ToolFactoryOptions } from './types';

export function createReadTool(_: ToolFactoryOptions) {
  return tool({
    description: 'Read a file from disk',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => await readFile(path, 'utf8'),
  });
}
