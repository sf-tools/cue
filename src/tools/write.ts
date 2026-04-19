import { writeFile } from 'node:fs/promises';

import { tool } from 'ai';
import { z } from 'zod';

import type { ToolFactoryOptions } from './types';

function previewContent(content: string, maxLines = 6, maxChars = 800) {
  const clipped = content.length > maxChars ? `${content.slice(0, maxChars)}\n… truncated ${content.length - maxChars} chars` : content;
  const lines = clipped.split('\n');
  return lines.length <= maxLines ? lines : [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`];
}

export function createWriteTool({ requestApproval }: ToolFactoryOptions) {
  return tool({
    description: 'Write content to a file',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      if (!(await requestApproval({
        scope: 'edit',
        title: 'Edit file',
        detail: `${path} · ${content.length} bytes`,
        body: previewContent(content)
      }))) {
        throw new Error('edit denied by user');
      }

      await writeFile(path, content);
      return `wrote ${content.length} bytes to ${path}`;
    }
  });
}
