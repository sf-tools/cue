import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { exists, readJsonSafe, truncate } from './utils';

type Formatter = {
  id: 'biome' | 'prettier' | 'ruff' | 'black' | 'rustfmt' | 'gofmt';
  label: string;
  buildCmd: (paths: string[], check: boolean) => string;
  defaultPaths: string[];
};

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePaths(paths: string[]) {
  return paths.map(shellQuote).join(' ');
}

async function detectFormatters(cwd: string): Promise<Formatter[]> {
  const found: Formatter[] = [];

  if ((await exists(`${cwd}/biome.json`)) || (await exists(`${cwd}/biome.jsonc`))) {
    found.push({
      id: 'biome',
      label: 'biome format',
      buildCmd: (paths, check) =>
        `bunx --bun @biomejs/biome format ${check ? '' : '--write '}${paths.length === 0 ? '.' : quotePaths(paths)}`.trim(),
      defaultPaths: ['.'],
    });
  }

  const pkg = await readJsonSafe(`${cwd}/package.json`);
  const hasPrettierConfig =
    (await exists(`${cwd}/.prettierrc`)) ||
    (await exists(`${cwd}/.prettierrc.json`)) ||
    (await exists(`${cwd}/.prettierrc.js`)) ||
    (await exists(`${cwd}/.prettierrc.cjs`)) ||
    (await exists(`${cwd}/prettier.config.js`)) ||
    Boolean(pkg && 'prettier' in pkg);

  if (hasPrettierConfig) {
    found.push({
      id: 'prettier',
      label: 'prettier',
      buildCmd: (paths, check) =>
        `bunx --bun prettier ${check ? '--check' : '--write'} ${paths.length === 0 ? '.' : quotePaths(paths)}`,
      defaultPaths: ['.'],
    });
  }

  if (await exists(`${cwd}/pyproject.toml`)) {
    const pyproject = await Bun.file(`${cwd}/pyproject.toml`).text();
    if (/\[tool\.ruff(\.format)?\]/.test(pyproject)) {
      found.push({
        id: 'ruff',
        label: 'ruff format',
        buildCmd: (paths, check) =>
          `ruff format ${check ? '--check ' : ''}${paths.length === 0 ? '.' : quotePaths(paths)}`.trim(),
        defaultPaths: ['.'],
      });
    } else if (/\[tool\.black\]/.test(pyproject)) {
      found.push({
        id: 'black',
        label: 'black',
        buildCmd: (paths, check) =>
          `black ${check ? '--check ' : ''}${paths.length === 0 ? '.' : quotePaths(paths)}`.trim(),
        defaultPaths: ['.'],
      });
    }
  }

  if (await exists(`${cwd}/Cargo.toml`)) {
    found.push({
      id: 'rustfmt',
      label: 'cargo fmt',
      buildCmd: (paths, check) => {
        const checkFlag = check ? ' --check' : '';
        if (paths.length === 0) return `cargo fmt --all${checkFlag ? ' --' : ''}${checkFlag}`;
        return `cargo fmt --${checkFlag} ${quotePaths(paths)}`;
      },
      defaultPaths: [],
    });
  }

  if (await exists(`${cwd}/go.mod`)) {
    found.push({
      id: 'gofmt',
      label: 'gofmt',
      buildCmd: (paths, check) => {
        const flags = check ? '-l' : '-w';
        return `gofmt ${flags} ${paths.length === 0 ? '.' : quotePaths(paths)}`;
      },
      defaultPaths: ['.'],
    });
  }

  return found;
}

export function createFormatTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Auto-detect the project formatter (biome / prettier / ruff / black / rustfmt / gofmt) and run it. Use `check: true` to verify without writing. Writes require approval.',
    inputSchema: z.object({
      paths: z
        .array(z.string())
        .optional()
        .describe('Paths to format. Omit for the whole project.'),
      check: z.boolean().optional().describe('Only check; do not modify files.'),
      formatter: z
        .enum(['biome', 'prettier', 'ruff', 'black', 'rustfmt', 'gofmt'])
        .optional()
        .describe('Force a specific formatter.'),
    }),
    execute: async ({ paths, check, formatter }) => {
      const cwd = process.cwd();
      const formatters = await detectFormatters(cwd);
      if (formatters.length === 0)
        return 'no formatter detected (looked for biome, prettier, ruff/black, rustfmt, gofmt)';

      const chosen = formatter ? formatters.find(item => item.id === formatter) : formatters[0];
      if (!chosen)
        return `formatter \`${formatter}\` not detected. found: ${formatters.map(f => f.id).join(', ')}`;

      const targets = paths ?? chosen.defaultPaths;
      const cmd = chosen.buildCmd(targets, Boolean(check));

      if (!check) {
        if (
          !(await requestApproval({
            scope: 'command',
            title: `Run ${chosen.label}`,
            detail: cmd,
          }))
        ) {
          throw new Error('command denied by user');
        }
      }

      const { exitCode, output } = await runUserShell(cmd);
      const text = plain(output).trim();
      const header = `${chosen.label}${check ? ' --check' : ''} · exit ${exitCode}`;
      if (!text) return `${header}\n(no output)`;
      return `${header}\n${truncate(text, 8000)}`;
    },
  });
}
