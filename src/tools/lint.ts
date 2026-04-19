import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { exists, readJsonSafe, truncate } from './utils';

type LinterId = 'biome' | 'eslint' | 'ruff' | 'clippy' | 'golangci' | 'mypy' | 'pyright';

type LinterRunResult = {
  exitCode: number;
  output: string;
};

type Diagnostic = {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  rule?: string;
  message: string;
  fixable?: boolean;
};

type Linter = {
  id: LinterId;
  label: string;
  buildCmd: (paths: string[], fix: boolean) => string;
  defaultPaths: string[];
  parse?: (result: LinterRunResult) => Diagnostic[] | null;
};

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePaths(paths: string[]) {
  return paths.map(shellQuote).join(' ');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseEslint(result: LinterRunResult): Diagnostic[] | null {
  const start = result.output.indexOf('[');
  if (start === -1) return null;
  const json = tryJson(result.output.slice(start));
  if (!Array.isArray(json)) return null;
  const diags: Diagnostic[] = [];
  for (const file of json) {
    if (typeof file !== 'object' || file === null) continue;
    const filePath = asString((file as Record<string, unknown>).filePath) ?? '';
    const messages = (file as Record<string, unknown>).messages;
    if (!Array.isArray(messages)) continue;
    for (const msg of messages) {
      if (typeof msg !== 'object' || msg === null) continue;
      const m = msg as Record<string, unknown>;
      diags.push({
        file: filePath,
        line: asNumber(m.line) ?? 0,
        column: asNumber(m.column),
        severity: m.severity === 2 ? 'error' : m.severity === 1 ? 'warning' : 'info',
        rule: asString(m.ruleId) ?? undefined,
        message: asString(m.message) ?? '',
        fixable: Boolean(m.fix)
      });
    }
  }
  return diags;
}

function parseBiome(result: LinterRunResult): Diagnostic[] | null {
  const start = result.output.indexOf('{');
  if (start === -1) return null;
  const json = tryJson(result.output.slice(start));
  if (typeof json !== 'object' || json === null) return null;
  const diagnostics = (json as Record<string, unknown>).diagnostics;
  if (!Array.isArray(diagnostics)) return null;
  const diags: Diagnostic[] = [];
  for (const entry of diagnostics) {
    if (typeof entry !== 'object' || entry === null) continue;
    const d = entry as Record<string, unknown>;
    const location = (d.location ?? {}) as Record<string, unknown>;
    const path = (location.path ?? {}) as Record<string, unknown>;
    const span = location.span as [number, number] | undefined;
    diags.push({
      file: asString(path.file) ?? asString(path.filePath) ?? '',
      line: span && typeof span[0] === 'number' ? span[0] : 0,
      severity:
        (d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : d.severity === 'information' ? 'info' : 'warning'),
      rule: asString(d.category) ?? undefined,
      message: asString(d.description) ?? asString(d.message) ?? ''
    });
  }
  return diags;
}

function parseRuff(result: LinterRunResult): Diagnostic[] | null {
  const start = result.output.indexOf('[');
  if (start === -1) return null;
  const json = tryJson(result.output.slice(start));
  if (!Array.isArray(json)) return null;
  const diags: Diagnostic[] = [];
  for (const entry of json) {
    if (typeof entry !== 'object' || entry === null) continue;
    const d = entry as Record<string, unknown>;
    const location = (d.location ?? {}) as Record<string, unknown>;
    diags.push({
      file: asString(d.filename) ?? '',
      line: asNumber(location.row) ?? 0,
      column: asNumber(location.column),
      severity: 'warning',
      rule: asString(d.code) ?? undefined,
      message: asString(d.message) ?? '',
      fixable: typeof d.fix === 'object' && d.fix !== null
    });
  }
  return diags;
}

function parseClippy(result: LinterRunResult): Diagnostic[] | null {
  const diags: Diagnostic[] = [];
  for (const line of result.output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    const json = tryJson(trimmed);
    if (typeof json !== 'object' || json === null) continue;
    const reason = (json as Record<string, unknown>).reason;
    if (reason !== 'compiler-message') continue;
    const message = (json as Record<string, unknown>).message;
    if (typeof message !== 'object' || message === null) continue;
    const m = message as Record<string, unknown>;
    const spans = m.spans;
    if (!Array.isArray(spans) || spans.length === 0) continue;
    const span = spans.find((s: unknown) => typeof s === 'object' && s !== null && (s as Record<string, unknown>).is_primary) ?? spans[0];
    if (typeof span !== 'object' || span === null) continue;
    const sp = span as Record<string, unknown>;
    diags.push({
      file: asString(sp.file_name) ?? '',
      line: asNumber(sp.line_start) ?? 0,
      column: asNumber(sp.column_start),
      severity: m.level === 'error' ? 'error' : m.level === 'warning' ? 'warning' : 'info',
      rule: typeof m.code === 'object' && m.code !== null ? asString((m.code as Record<string, unknown>).code) : undefined,
      message: asString(m.message) ?? ''
    });
  }
  return diags.length > 0 ? diags : null;
}

async function detectLinters(cwd: string): Promise<Linter[]> {
  const found: Linter[] = [];

  if ((await exists(`${cwd}/biome.json`)) || (await exists(`${cwd}/biome.jsonc`))) {
    found.push({
      id: 'biome',
      label: 'biome lint',
      buildCmd: (paths, fix) =>
        `bunx --bun @biomejs/biome lint --reporter json ${fix ? '--apply ' : ''}${paths.length === 0 ? '.' : quotePaths(paths)}`.trim(),
      defaultPaths: ['.'],
      parse: parseBiome
    });
  }

  const pkg = await readJsonSafe(`${cwd}/package.json`);
  const hasEslint =
    (await exists(`${cwd}/.eslintrc`)) ||
    (await exists(`${cwd}/.eslintrc.js`)) ||
    (await exists(`${cwd}/.eslintrc.cjs`)) ||
    (await exists(`${cwd}/.eslintrc.json`)) ||
    (await exists(`${cwd}/eslint.config.js`)) ||
    (await exists(`${cwd}/eslint.config.mjs`)) ||
    (await exists(`${cwd}/eslint.config.ts`)) ||
    Boolean(pkg && 'eslintConfig' in pkg);

  if (hasEslint) {
    found.push({
      id: 'eslint',
      label: 'eslint',
      buildCmd: (paths, fix) => `bunx --bun eslint --format json ${fix ? '--fix ' : ''}${paths.length === 0 ? '.' : quotePaths(paths)}`,
      defaultPaths: ['.'],
      parse: parseEslint
    });
  }

  if (await exists(`${cwd}/pyproject.toml`)) {
    const pyproject = await Bun.file(`${cwd}/pyproject.toml`).text();
    if (/\[tool\.ruff(\.|\])/.test(pyproject)) {
      found.push({
        id: 'ruff',
        label: 'ruff check',
        buildCmd: (paths, fix) =>
          `ruff check --output-format json ${fix ? '--fix ' : ''}${paths.length === 0 ? '.' : quotePaths(paths)}`.trim(),
        defaultPaths: ['.'],
        parse: parseRuff
      });
    }
    if (/\[tool\.mypy\]/.test(pyproject)) {
      found.push({
        id: 'mypy',
        label: 'mypy',
        buildCmd: paths => `mypy ${paths.length === 0 ? '.' : quotePaths(paths)}`,
        defaultPaths: ['.']
      });
    }
    if (/\[tool\.pyright\]/.test(pyproject)) {
      found.push({
        id: 'pyright',
        label: 'pyright',
        buildCmd: paths => `pyright ${paths.length === 0 ? '' : quotePaths(paths)}`.trim(),
        defaultPaths: []
      });
    }
  }

  if (await exists(`${cwd}/Cargo.toml`)) {
    found.push({
      id: 'clippy',
      label: 'cargo clippy',
      buildCmd: (paths, fix) => {
        const fixFlag = fix ? '--fix --allow-dirty --allow-staged ' : '';
        const pathSpec = paths.length === 0 ? '' : ` -p ${quotePaths(paths)}`;
        return `cargo clippy ${fixFlag}--message-format=json --quiet${pathSpec}`.trim();
      },
      defaultPaths: [],
      parse: parseClippy
    });
  }

  if ((await exists(`${cwd}/.golangci.yml`)) || (await exists(`${cwd}/.golangci.yaml`)) || (await exists(`${cwd}/go.mod`))) {
    found.push({
      id: 'golangci',
      label: 'golangci-lint',
      buildCmd: (paths, fix) => {
        const fixFlag = fix ? '--fix ' : '';
        const target = paths.length === 0 ? './...' : quotePaths(paths);
        return `golangci-lint run ${fixFlag}--out-format json ${target}`.trim();
      },
      defaultPaths: []
    });
  }

  return found;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

function renderDiagnostics(label: string, diags: Diagnostic[], limit: number) {
  if (diags.length === 0) return `${label}: no findings`;
  const sorted = [...diags].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line
  );
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of sorted) counts[d.severity] += 1;
  const summary = [
    counts.error ? `${counts.error} error${counts.error === 1 ? '' : 's'}` : null,
    counts.warning ? `${counts.warning} warning${counts.warning === 1 ? '' : 's'}` : null,
    counts.info ? `${counts.info} info` : null
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [`${label}: ${summary || `${diags.length} findings`}`];
  for (const diag of sorted.slice(0, limit)) {
    const loc = diag.column ? `${diag.line}:${diag.column}` : `${diag.line}`;
    const rule = diag.rule ? ` [${diag.rule}]` : '';
    const fixable = diag.fixable ? ' (fixable)' : '';
    lines.push(`  ${diag.severity[0].toUpperCase()} ${diag.file}:${loc}${rule}${fixable} — ${diag.message}`);
  }
  if (sorted.length > limit) lines.push(`  … ${sorted.length - limit} more`);
  return lines.join('\n');
}

export function createLintTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Auto-detect the project linter (biome / eslint / ruff / clippy / golangci-lint / mypy / pyright) and run it. Output is parsed into structured diagnostics where supported. Pass `fix: true` to apply auto-fixes (requires approval).',
    inputSchema: z.object({
      paths: z.array(z.string()).optional().describe('Paths to lint. Omit for the whole project.'),
      fix: z.boolean().optional().describe('Apply auto-fixes (requires command approval).'),
      linter: z.enum(['biome', 'eslint', 'ruff', 'clippy', 'golangci', 'mypy', 'pyright']).optional().describe('Force a specific linter.'),
      max_diagnostics: z.number().int().positive().max(500).optional()
    }),
    execute: async ({ paths, fix, linter, max_diagnostics }) => {
      const cwd = process.cwd();
      const linters = await detectLinters(cwd);
      if (linters.length === 0) return 'no linter detected (looked for biome, eslint, ruff, clippy, golangci-lint, mypy, pyright)';

      const chosen = linter ? linters.find(item => item.id === linter) : linters[0];
      if (!chosen) return `linter \`${linter}\` not detected. found: ${linters.map(l => l.id).join(', ')}`;

      const targets = paths ?? chosen.defaultPaths;
      const cmd = chosen.buildCmd(targets, Boolean(fix));

      if (fix) {
        if (
          !(await requestApproval({
            scope: 'command',
            title: `Run ${chosen.label} --fix`,
            detail: cmd
          }))
        ) {
          throw new Error('command denied by user');
        }
      }

      const result = await runUserShell(cmd);
      const cleaned = plain(result.output);
      const header = `${chosen.label}${fix ? ' --fix' : ''} · exit ${result.exitCode}`;

      if (chosen.parse) {
        const diags = chosen.parse({ exitCode: result.exitCode, output: cleaned });
        if (diags) {
          const limit = max_diagnostics ?? 50;
          return `${header}\n${renderDiagnostics(chosen.label, diags, limit)}`;
        }
      }

      const trimmed = cleaned.trim();
      if (!trimmed) return `${header}\n(no output)`;
      return `${header}\n${truncate(trimmed, 8000)}`;
    }
  });
}
