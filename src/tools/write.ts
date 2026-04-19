import { writeFile } from 'node:fs/promises';

import { tool } from 'ai';
import { z } from 'zod';

import type { ToolFactoryOptions } from './types';

export function createWriteTool(_: ToolFactoryOptions) {
  return tool({
    description: 'Write content to a file',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      await writeFile(path, content);
      return `wrote ${content.length} bytes to ${path}`;
    }
  });
}
