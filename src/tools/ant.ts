import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';

function previewScript(script: string, maxLines = 8, maxChars = 1200) {
  const clipped = script.length > maxChars ? `${script.slice(0, maxChars)}\n… truncated ${script.length - maxChars} chars` : script;
  const lines = clipped.split('\n');
  return lines.length <= maxLines ? lines : [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`];
}

export function createAntTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description: 'Execute an ad-hoc JavaScript script with ant from PATH.',
    inputSchema: z.object({
      script: z.string().min(1).describe('JavaScript source to execute with ant'),
      args: z.array(z.string()).optional().describe('Optional command-line arguments passed to the script')
    }),
    execute: async ({ script, args = [] }) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'cue-ant-'));
      const scriptPath = join(tempDir, 'script.js');
      const argText = args.map(arg => JSON.stringify(arg)).join(' ');
      const cmd = `ANT_BIN="$(which ant)" && [ -n "$ANT_BIN" ] && "$ANT_BIN" ${JSON.stringify(scriptPath)}${argText ? ` ${argText}` : ''}`;

      try {
        await writeFile(scriptPath, script);

        if (
          !(await requestApproval({
            scope: 'command',
            title: 'Run JavaScript with ant',
            detail: `$(which ant) ${scriptPath}${args.length ? ` ${args.join(' ')}` : ''}`,
            body: previewScript(script)
          }))
        ) {
          throw new Error('command denied by user');
        }

        const { output, exitCode } = await runUserShell(cmd);
        const trimmed = plain(output).trimEnd();
        if (trimmed) return trimmed.slice(0, 4000);
        if (exitCode === 0) return '(no output)';
        return `error: command exited with code ${exitCode}`;
      } catch (error: unknown) {
        return `error: ${plain(error instanceof Error ? error.message : String(error))}`;
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });
}
