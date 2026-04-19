import { tool } from 'ai';
import { z } from 'zod';

import { queryMentionIndexAwait } from '@/agent/mention-index';

const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 500;

const EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules', 'dist', '.DS_Store']);

function isExcluded(path: string) {
  for (const segment of path.split('/')) {
    if (EXCLUDED_SEGMENTS.has(segment)) return true;
  }
  return false;
}

async function runGlob(pattern: string, cwd: string, limit: number) {
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];

  for await (const file of glob.scan({ cwd, onlyFiles: false, dot: false })) {
    if (isExcluded(file)) continue;
    matches.push(file);
    if (matches.length >= limit) break;
  }

  matches.sort((a, b) => a.localeCompare(b));
  return matches;
}

export function createFindFileTool() {
  return tool({
    description:
      'Find files in the workspace. Use `pattern` for glob (e.g. `src/**/*.tsx`) or `query` for fuzzy substring (e.g. `mention idx`). Returns repo-relative paths.',
    inputSchema: z
      .object({
        pattern: z
          .string()
          .min(1)
          .optional()
          .describe('Glob pattern, e.g. `src/**/*.ts` or `**/package.json`.'),
        query: z
          .string()
          .min(1)
          .optional()
          .describe('Fuzzy substring search across file names and paths.'),
        limit: z.number().int().positive().max(HARD_LIMIT).optional(),
      })
      .refine(value => Boolean(value.pattern) !== Boolean(value.query), {
        message: 'provide exactly one of `pattern` or `query`',
      }),
    execute: async ({ pattern, query, limit }) => {
      const cap = Math.min(limit ?? DEFAULT_LIMIT, HARD_LIMIT);
      const cwd = process.cwd();

      if (pattern) {
        const matches = await runGlob(pattern, cwd, cap);
        if (matches.length === 0) return `no files matched glob \`${pattern}\``;
        const truncated = matches.length >= cap ? `\n… stopped at ${cap} matches` : '';
        return `${matches.length} match${matches.length === 1 ? '' : 'es'} for \`${pattern}\`:\n${matches.join('\n')}${truncated}`;
      }

      const results = (await queryMentionIndexAwait(query!, cap, cwd)).filter(
        entry => entry.kind === 'file',
      );
      if (results.length === 0) return `no files matched query \`${query}\``;
      const lines = results.map(entry => entry.label);
      return `${lines.length} match${lines.length === 1 ? '' : 'es'} for \`${query}\`:\n${lines.join('\n')}`;
    },
  });
}
