import { readFile, writeFile, access, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';

const MAX_OUTPUT_CHARS = 6000;

function truncate(text: string, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… truncated ${text.length - max} chars`;
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

type Ecosystem = {
  language: 'typescript' | 'javascript' | 'python' | 'rust' | 'go';
  manifest: string;
  lock: string | null;
  installCmd: string;
  packages: { name: string; version: string; kind: 'prod' | 'dev' | 'unknown' }[];
};

async function detectInstaller(cwd: string): Promise<{ cmd: string; lock: string | null }> {
  if (await exists(join(cwd, 'bun.lock'))) return { cmd: 'bun install', lock: 'bun.lock' };
  if (await exists(join(cwd, 'bun.lockb'))) return { cmd: 'bun install', lock: 'bun.lockb' };
  if (await exists(join(cwd, 'pnpm-lock.yaml'))) return { cmd: 'pnpm install', lock: 'pnpm-lock.yaml' };
  if (await exists(join(cwd, 'yarn.lock'))) return { cmd: 'yarn', lock: 'yarn.lock' };
  if (await exists(join(cwd, 'package-lock.json'))) return { cmd: 'npm install', lock: 'package-lock.json' };
  return { cmd: 'npm install', lock: null };
}

async function scanEcosystems(cwd: string): Promise<Ecosystem[]> {
  const out: Ecosystem[] = [];

  const pkgPath = join(cwd, 'package.json');
  const pkg = await readJsonSafe(pkgPath);
  if (pkg) {
    const installer = await detectInstaller(cwd);
    const prod = (pkg.dependencies as Record<string, string> | undefined) ?? {};
    const dev = (pkg.devDependencies as Record<string, string> | undefined) ?? {};
    const isTs = !!dev.typescript || !!prod.typescript || (await exists(join(cwd, 'tsconfig.json')));
    out.push({
      language: isTs ? 'typescript' : 'javascript',
      manifest: 'package.json',
      lock: installer.lock,
      installCmd: installer.cmd,
      packages: [
        ...Object.entries(prod).map(([name, version]) => ({ name, version, kind: 'prod' as const })),
        ...Object.entries(dev).map(([name, version]) => ({ name, version, kind: 'dev' as const }))
      ]
    });
  }

  if (await exists(join(cwd, 'pyproject.toml'))) {
    const text = await readFile(join(cwd, 'pyproject.toml'), 'utf8').catch(() => '');
    const packages: Ecosystem['packages'] = [];
    const depBlock = text.match(/\[(?:project|tool\.poetry)\.dependencies\]([\s\S]*?)(?=^\[|\Z)/m);
    if (depBlock) {
      for (const m of depBlock[1].matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/gm)) {
        packages.push({ name: m[1], version: m[2], kind: 'prod' });
      }
    }
    const arrayDeps = text.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
    if (arrayDeps) {
      for (const m of arrayDeps[1].matchAll(/"([^"]+)"/g)) {
        const spec = m[1];
        const name = spec.split(/[<>=!~ ]/)[0];
        const version = spec.slice(name.length).trim() || '*';
        packages.push({ name, version, kind: 'prod' });
      }
    }
    out.push({
      language: 'python',
      manifest: 'pyproject.toml',
      lock: (await exists(join(cwd, 'uv.lock'))) ? 'uv.lock' : (await exists(join(cwd, 'poetry.lock'))) ? 'poetry.lock' : null,
      installCmd: (await exists(join(cwd, 'uv.lock'))) ? 'uv sync' : (await exists(join(cwd, 'poetry.lock'))) ? 'poetry install' : 'pip install -e .',
      packages
    });
  }

  if (await exists(join(cwd, 'Cargo.toml'))) {
    const text = await readFile(join(cwd, 'Cargo.toml'), 'utf8').catch(() => '');
    const packages: Ecosystem['packages'] = [];
    const depBlock = text.match(/^\[dependencies\]([\s\S]*?)(?=^\[|\Z)/m);
    if (depBlock) {
      for (const m of depBlock[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*("([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) {
        packages.push({ name: m[1], version: m[3] ?? m[4] ?? '*', kind: 'prod' });
      }
    }
    out.push({
      language: 'rust',
      manifest: 'Cargo.toml',
      lock: (await exists(join(cwd, 'Cargo.lock'))) ? 'Cargo.lock' : null,
      installCmd: 'cargo build',
      packages
    });
  }

  if (await exists(join(cwd, 'go.mod'))) {
    const text = await readFile(join(cwd, 'go.mod'), 'utf8').catch(() => '');
    const packages: Ecosystem['packages'] = [];
    for (const m of text.matchAll(/^\s*([\w./-]+)\s+(v[^\s]+)/gm)) {
      packages.push({ name: m[1], version: m[2], kind: 'prod' });
    }
    out.push({
      language: 'go',
      manifest: 'go.mod',
      lock: (await exists(join(cwd, 'go.sum'))) ? 'go.sum' : null,
      installCmd: 'go mod tidy',
      packages
    });
  }

  return out;
}

type Graph = {
  builtAt: number;
  cwd: string;
  files: string[];
  edges: Map<string, Set<string>>;
};

let cachedGraph: Graph | null = null;

const TS_JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

async function listSourceFiles(cwd: string, runUserShell: ToolFactoryOptions['runUserShell']) {
  const cmd = `if command -v rg >/dev/null 2>&1; then command rg --files -g '*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs}' --hidden -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/.git/**' -g '!**/target/**' -g '!**/build/**' ${JSON.stringify(cwd)}; else find ${JSON.stringify(cwd)} -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.py' -o -name '*.go' -o -name '*.rs' \\) -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.git/*' -not -path '*/target/*' -not -path '*/build/*'; fi`;
  const { output } = await runUserShell(cmd);
  return plain(output).trim().split('\n').filter(Boolean);
}

async function resolveTsJsImport(fromFile: string, spec: string, cwd: string): Promise<string | null> {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const baseDir = dirname(fromFile);
  const resolved = isAbsolute(spec) ? join(cwd, spec) : resolve(baseDir, spec);
  if (extname(resolved) && (await isFile(resolved))) return resolved;
  for (const ext of TS_JS_EXTS) {
    if (await isFile(`${resolved}${ext}`)) return `${resolved}${ext}`;
  }
  for (const ext of TS_JS_EXTS) {
    const indexPath = join(resolved, `index${ext}`);
    if (await isFile(indexPath)) return indexPath;
  }
  return null;
}

function extractTsJsImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of source.matchAll(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

function extractPythonImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*from\s+(\S+)\s+import\b/gm)) out.push(m[1]);
  for (const m of source.matchAll(/^\s*import\s+([\w.]+)/gm)) out.push(m[1]);
  return out;
}

function extractGoImports(source: string): string[] {
  const out: string[] = [];
  const block = source.match(/import\s*\(([\s\S]*?)\)/);
  if (block) for (const m of block[1].matchAll(/"([^"]+)"/g)) out.push(m[1]);
  for (const m of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) out.push(m[1]);
  return out;
}

function extractRustImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*use\s+([\w:]+)/gm)) out.push(m[1].split('::')[0]);
  return out;
}

async function buildGraph(cwd: string, runUserShell: ToolFactoryOptions['runUserShell']): Promise<Graph> {
  const files = await listSourceFiles(cwd, runUserShell);
  const edges = new Map<string, Set<string>>();
  for (const file of files) edges.set(file, new Set());

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    let source = '';
    try {
      source = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let imports: string[] = [];
    if (TS_JS_EXTS.includes(ext)) imports = extractTsJsImports(source);
    else if (ext === '.py') imports = extractPythonImports(source);
    else if (ext === '.go') imports = extractGoImports(source);
    else if (ext === '.rs') imports = extractRustImports(source);

    const set = edges.get(file)!;
    for (const spec of imports) {
      if (TS_JS_EXTS.includes(ext)) {
        const resolved = await resolveTsJsImport(file, spec, cwd);
        if (resolved) set.add(resolved);
        else set.add(`pkg:${spec}`);
      } else {
        set.add(`mod:${spec}`);
      }
    }
  }

  return { builtAt: Date.now(), cwd, files, edges };
}

function reverseGraph(graph: Graph): Map<string, Set<string>> {
  const rev = new Map<string, Set<string>>();
  for (const [from, tos] of graph.edges) {
    for (const to of tos) {
      if (!rev.has(to)) rev.set(to, new Set());
      rev.get(to)!.add(from);
    }
  }
  return rev;
}

function transitive(start: string, graph: Map<string, Set<string>>, limit = 200): string[] {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length && seen.size < limit) {
    const cur = stack.pop()!;
    const next = graph.get(cur);
    if (!next) continue;
    for (const n of next) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  seen.delete(start);
  return Array.from(seen);
}

async function findSymbolReferences(
  symbol: string,
  cwd: string,
  runUserShell: ToolFactoryOptions['runUserShell']
): Promise<{ file: string; line: number; text: string }[]> {
  const pattern = `\\b${symbol}\\b`;
  const cmd = `if command -v rg >/dev/null 2>&1; then command rg --line-number --no-heading --color=never -e ${JSON.stringify(pattern)} -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/.git/**' -g '!**/target/**' ${JSON.stringify(cwd)}; else true; fi`;
  const { output } = await runUserShell(cmd);
  const lines = plain(output).trim().split('\n').filter(Boolean);
  const out: { file: string; line: number; text: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    out.push({ file: m[1], line: Number(m[2]), text: m[3] });
  }
  return out;
}

function renameInSource(source: string, oldName: string, newName: string): { result: string; replaced: number } {
  const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  let replaced = 0;
  const result = source.replace(re, () => {
    replaced += 1;
    return newName;
  });
  return { result, replaced };
}

export function createDepsTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Map and manage dependencies (package manifests + internal import graph). Subactions: scan, graph.build, graph.impact, pkg.bump, pkg.audit, symbol.rename, verify.',
    inputSchema: z.object({
      action: z.enum(['scan', 'graph.build', 'graph.impact', 'pkg.bump', 'pkg.audit', 'symbol.rename', 'verify']),
      path: z.string().optional(),
      ecosystem: z.enum(['typescript', 'javascript', 'python', 'rust', 'go']).optional(),
      packageName: z.string().optional(),
      version: z.string().optional(),
      kind: z.enum(['prod', 'dev']).optional(),
      symbol: z.string().optional(),
      newName: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
      skipInstall: z.boolean().optional(),
      includeNodeModules: z.boolean().optional(),
      typecheck: z.boolean().optional()
    }),
    execute: async ({ action, path, ecosystem, packageName, version, kind, symbol, newName, limit, skipInstall, includeNodeModules, typecheck }) => {
      const cwd = process.cwd();

      if (action === 'scan') {
        const ecosystems = await scanEcosystems(cwd);
        return {
          ecosystems: ecosystems.map(eco => ({
            language: eco.language,
            manifest: eco.manifest,
            lock: eco.lock,
            installCmd: eco.installCmd,
            packageCount: eco.packages.length,
            packages: eco.packages.slice(0, 200)
          }))
        };
      }

      if (action === 'graph.build') {
        cachedGraph = await buildGraph(cwd, runUserShell);
        return {
          builtAt: cachedGraph.builtAt,
          fileCount: cachedGraph.files.length,
          edgeCount: Array.from(cachedGraph.edges.values()).reduce((s, set) => s + set.size, 0)
        };
      }

      if (action === 'graph.impact') {
        if (!path) throw new Error('graph.impact requires `path`');
        if (!cachedGraph) cachedGraph = await buildGraph(cwd, runUserShell);
        const target = resolve(cwd, path);
        const rev = reverseGraph(cachedGraph);
        const importers = transitive(target, rev, limit ?? 200).map(p => relative(cwd, p));
        const dependencies = transitive(target, cachedGraph.edges, limit ?? 200).map(p =>
          p.startsWith('pkg:') || p.startsWith('mod:') ? p : relative(cwd, p)
        );
        return {
          target: relative(cwd, target),
          forwardImporterCount: importers.length,
          forwardImporters: importers.slice(0, 100),
          backwardDependencyCount: dependencies.length,
          backwardDependencies: dependencies.slice(0, 100)
        };
      }

      if (action === 'pkg.bump') {
        if (!packageName || !version) throw new Error('pkg.bump requires `packageName` and `version`');
        const ecosystems = await scanEcosystems(cwd);
        const target =
          (ecosystem ? ecosystems.find(e => e.language === ecosystem) : null) ??
          ecosystems.find(e => e.packages.some(p => p.name === packageName)) ??
          ecosystems[0];
        if (!target) throw new Error('no ecosystem detected to bump in');

        const manifestPath = join(cwd, target.manifest);
        const manifestText = await readFile(manifestPath, 'utf8');
        let nextText = manifestText;

        if (target.manifest === 'package.json') {
          const json = JSON.parse(manifestText) as Record<string, Record<string, string> | undefined>;
          const section =
            kind === 'dev'
              ? 'devDependencies'
              : json.dependencies?.[packageName]
                ? 'dependencies'
                : json.devDependencies?.[packageName]
                  ? 'devDependencies'
                  : 'dependencies';
          json[section] = { ...(json[section] ?? {}), [packageName]: version };
          nextText = `${JSON.stringify(json, null, 2)}\n`;
        } else if (target.manifest === 'Cargo.toml' || target.manifest === 'pyproject.toml') {
          const re = new RegExp(`(^\\s*${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*")[^"]+(")`, 'm');
          if (re.test(manifestText)) {
            nextText = manifestText.replace(re, (_, a, b) => `${a}${version}${b}`);
          } else {
            throw new Error(`could not locate \`${packageName}\` in ${target.manifest}; manual edit needed`);
          }
        } else if (target.manifest === 'go.mod') {
          const goVersion = version.startsWith('v') ? version : `v${version}`;
          const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`(^\\s*(?:require\\s+)?${escaped}\\s+)v\\S+`, 'm');
          if (re.test(manifestText)) {
            nextText = manifestText.replace(re, (_, prefix) => `${prefix}${goVersion}`);
          } else {
            throw new Error(`could not locate \`${packageName}\` in go.mod; manual edit needed`);
          }
        } else {
          throw new Error(`unsupported manifest: ${target.manifest}`);
        }

        if (
          !(await requestApproval({
            scope: 'edit',
            title: 'Bump dependency',
            detail: `${target.manifest} · ${packageName} → ${version}`,
            body: [`ecosystem: ${target.language}`, `install command (next step): ${target.installCmd}`]
          }))
        ) {
          throw new Error('pkg.bump denied by user');
        }
        await writeFile(manifestPath, nextText);

        if (skipInstall) {
          return { manifest: target.manifest, packageName, version, installed: false };
        }

        if (
          !(await requestApproval({
            scope: 'command',
            title: 'Install updated dependencies',
            detail: target.installCmd
          }))
        ) {
          return { manifest: target.manifest, packageName, version, installed: false, note: 'install denied by user' };
        }
        const { output, exitCode } = await runUserShell(target.installCmd);
        return {
          manifest: target.manifest,
          packageName,
          version,
          installed: exitCode === 0,
          installExitCode: exitCode,
          installOutput: truncate(plain(output).trimEnd(), 3000)
        };
      }

      if (action === 'pkg.audit') {
        const ecosystems = await scanEcosystems(cwd);
        const target = (ecosystem ? ecosystems.find(e => e.language === ecosystem) : null) ?? ecosystems[0];
        if (!target) throw new Error('no ecosystem detected');
        let cmd: string;
        switch (target.language) {
          case 'typescript':
          case 'javascript':
            cmd = target.installCmd.startsWith('bun')
              ? 'bun audit'
              : target.installCmd.startsWith('pnpm')
                ? 'pnpm audit'
                : target.installCmd.startsWith('yarn')
                  ? 'yarn npm audit'
                  : 'npm audit';
            break;
          case 'python':
            cmd = (await exists(join(cwd, 'uv.lock'))) ? 'uv pip list --outdated' : 'pip-audit || pip list --outdated';
            break;
          case 'rust':
            cmd = 'cargo audit || cargo install cargo-audit --quiet && cargo audit';
            break;
          case 'go':
            cmd = 'govulncheck ./...';
            break;
        }
        if (
          !(await requestApproval({
            scope: 'command',
            title: 'Audit dependencies',
            detail: cmd,
            body: [`ecosystem: ${target.language}`]
          }))
        ) {
          throw new Error('audit denied by user');
        }
        const { output, exitCode } = await runUserShell(cmd);
        return { ecosystem: target.language, cmd, exitCode, output: truncate(plain(output).trimEnd()) };
      }

      if (action === 'symbol.rename') {
        if (!symbol || !newName) throw new Error('symbol.rename requires `symbol` and `newName`');
        if (!/^[A-Za-z_$][\w$]*$/.test(symbol) || !/^[A-Za-z_$][\w$]*$/.test(newName)) {
          throw new Error('symbol and newName must be simple identifiers');
        }
        const refs = await findSymbolReferences(symbol, cwd, runUserShell);
        const filtered = refs.filter(r => includeNodeModules || !r.file.includes('/node_modules/'));
        const byFile = new Map<string, number>();
        for (const r of filtered) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
        const fileEntries = Array.from(byFile.entries()).sort((a, b) => b[1] - a[1]);

        if (fileEntries.length === 0) {
          return { renamed: 0, files: [], note: 'no references found' };
        }

        const previewLines = fileEntries.slice(0, 12).map(([f, c]) => `${c.toString().padStart(4)}× ${relative(cwd, f)}`);
        if (fileEntries.length > 12) previewLines.push(`… ${fileEntries.length - 12} more file${fileEntries.length - 12 === 1 ? '' : 's'}`);

        if (
          !(await requestApproval({
            scope: 'edit',
            title: 'Rename symbol across project',
            detail: `${symbol} → ${newName} · ${fileEntries.length} file${fileEntries.length === 1 ? '' : 's'}, ${filtered.length} reference${filtered.length === 1 ? '' : 's'}`,
            body: previewLines
          }))
        ) {
          throw new Error('symbol.rename denied by user');
        }

        const updated: { file: string; replaced: number }[] = [];
        for (const [file] of fileEntries) {
          const source = await readFile(file, 'utf8').catch(() => null);
          if (source === null) continue;
          const { result, replaced } = renameInSource(source, symbol, newName);
          if (replaced > 0 && result !== source) {
            await writeFile(file, result);
            updated.push({ file: relative(cwd, file), replaced });
          }
        }
        return {
          symbol,
          newName,
          fileCount: updated.length,
          totalReplacements: updated.reduce((s, u) => s + u.replaced, 0),
          updated,
          warning: 'textual rename — verify by running `deps` action `verify` (typecheck + tests)'
        };
      }

      if (action === 'verify') {
        const ecosystems = await scanEcosystems(cwd);
        const target = (ecosystem ? ecosystems.find(e => e.language === ecosystem) : null) ?? ecosystems[0];
        if (!target) throw new Error('no ecosystem detected');

        const steps: { name: string; cmd: string }[] = [];
        if (typecheck !== false) {
          if (target.language === 'typescript') steps.push({ name: 'typecheck', cmd: 'npx tsc --noEmit' });
          else if (target.language === 'python') steps.push({ name: 'typecheck', cmd: 'mypy . 2>/dev/null || true' });
          else if (target.language === 'rust') steps.push({ name: 'typecheck', cmd: 'cargo check' });
          else if (target.language === 'go') steps.push({ name: 'typecheck', cmd: 'go vet ./...' });
        }
        switch (target.language) {
          case 'typescript':
          case 'javascript':
            steps.push({ name: 'tests', cmd: target.installCmd.startsWith('bun') ? 'bun test' : 'npm test' });
            break;
          case 'python':
            steps.push({ name: 'tests', cmd: 'pytest -x' });
            break;
          case 'rust':
            steps.push({ name: 'tests', cmd: 'cargo test' });
            break;
          case 'go':
            steps.push({ name: 'tests', cmd: 'go test ./...' });
            break;
        }

        if (
          !(await requestApproval({
            scope: 'command',
            title: 'Verify (typecheck + tests)',
            detail: steps.map(s => s.cmd).join(' && '),
            body: steps.map(s => `${s.name}: ${s.cmd}`)
          }))
        ) {
          throw new Error('verify denied by user');
        }

        const results: { name: string; cmd: string; exitCode: number; ok: boolean; output: string }[] = [];
        for (const step of steps) {
          const { output, exitCode } = await runUserShell(step.cmd);
          results.push({
            name: step.name,
            cmd: step.cmd,
            exitCode,
            ok: exitCode === 0,
            output: truncate(plain(output).trimEnd(), 2500)
          });
          if (exitCode !== 0) break;
        }
        return { ok: results.every(r => r.ok), results };
      }

      throw new Error(`unknown action: ${String(action)}`);
    }
  });
}
