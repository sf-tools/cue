import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';

const ENGINE_PREFIX = '__cue_engine=';
const MAX_OUTPUT_CHARS = 4000;

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function trimOutput(value: string) {
  const trimmed = plain(value).trimEnd();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return { text: trimmed, truncated: false };

  return {
    text: `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n… truncated ${trimmed.length - MAX_OUTPUT_CHARS} chars`,
    truncated: true
  };
}

export function createRipgrepTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description: 'Search workspace text with ripgrep; falls back to grep when rg is unavailable',
    inputSchema: z.object({
      pattern: z.string().min(1),
      path: z.string().default('.')
    }),
    execute: async ({ pattern, path = '.' }) => {
      const escapedPattern = shellEscape(pattern);
      const escapedPath = shellEscape(path);
      const command = `if command -v rg >/dev/null 2>&1; then printf '%s\\n' '${ENGINE_PREFIX}rg'; command rg --line-number --no-heading --color=never -- ${escapedPattern} ${escapedPath}; else printf '%s\\n' '${ENGINE_PREFIX}grep'; command grep -RIn -- ${escapedPattern} ${escapedPath}; fi`;

      try {
        const { output, exitCode } = await runUserShell(command);
        const normalized = plain(output).trimEnd();
        const [firstLine = '', ...restLines] = normalized ? normalized.split('\n') : [''];
        const engine = firstLine.startsWith(ENGINE_PREFIX) ? firstLine.slice(ENGINE_PREFIX.length) : 'grep';
        const rawOutput = firstLine.startsWith(ENGINE_PREFIX) ? restLines.join('\n').trimEnd() : normalized;

        if (exitCode !== 0 && exitCode !== 1) {
          throw new Error(rawOutput || `search exited with code ${exitCode}`);
        }

        const { text, truncated } = trimOutput(rawOutput);
        const matches = rawOutput ? rawOutput.split('\n').filter(Boolean).length : 0;

        return {
          engine,
          pattern,
          path,
          matches,
          truncated,
          output: text
        };
      } catch (error: unknown) {
        throw new Error(plain(error instanceof Error ? error.message : String(error)));
      }
    }
  });
}
