import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { exists, readJsonSafe, truncate } from './utils';

type Ecosystem = {
  language: 'typescript' | 'javascript' | 'python' | 'rust' | 'go';
  manifest: string;
  lock: string | null;
  installCmd: string;
  packages: { name: string; version: string; kind: 'prod' | 'dev' | 'unknown' }[];
};

type Graph = {
  builtAt: number;
  cwd: string;
  files: string[];
  edges: Map<string, Set<string>>;
};

const TS_JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
let cachedGraph: Graph | null = null;

async function isFile(path: string) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

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

  const pkg = await readJsonSafe(join(cwd, 'package.json'));
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
      for (const match of depBlock[1].matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/gm)) {
        packages.push({ name: match[1], version: match[2], kind: 'prod' });
      }
    }
    const arrayDeps = text.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
    if (arrayDeps) {
      for (const match of arrayDeps[1].matchAll(/"([^"]+)"/g)) {
        const spec = match[1];
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
      for (const match of depBlock[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*("([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) {
        packages.push({ name: match[1], version: match[3] ?? match[4] ?? '*', kind: 'prod' });
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
    for (const match of text.matchAll(/^\s*([\w./-]+)\s+(v[^\s]+)/gm)) {
      packages.push({ name: match[1], version: match[2], kind: 'prod' });
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
  for (const match of source.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm)) out.push(match[1]);
  for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(match[1]);
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(match[1]);
  for (const match of source.matchAll(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm)) out.push(match[1]);
  return out;
}

function extractPythonImports(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/^\s*from\s+(\S+)\s+import\b/gm)) out.push(match[1]);
  for (const match of source.matchAll(/^\s*import\s+([\w.]+)/gm)) out.push(match[1]);
  return out;
}

function extractGoImports(source: string): string[] {
  const out: string[] = [];
  const block = source.match(/import\s*\(([\s\S]*?)\)/);
  if (block) {
    for (const match of block[1].matchAll(/"([^"]+)"/g)) out.push(match[1]);
  }
  for (const match of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) out.push(match[1]);
  return out;
}

function extractRustImports(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/^\s*use\s+([\w:]+)/gm)) out.push(match[1].split('::')[0]);
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

    const targets = edges.get(file)!;
    for (const spec of imports) {
      if (TS_JS_EXTS.includes(ext)) {
        const resolved = await resolveTsJsImport(file, spec, cwd);
        if (resolved) targets.add(resolved);
        else targets.add(`pkg:${spec}`);
      } else {
        targets.add(`mod:${spec}`);
      }
    }
  }

  return { builtAt: Date.now(), cwd, files, edges };
}

async function getGraph(cwd: string, runUserShell: ToolFactoryOptions['runUserShell']) {
  if (!cachedGraph || cachedGraph.cwd !== cwd) {
    cachedGraph = await buildGraph(cwd, runUserShell);
  }
  return cachedGraph;
}

function reverseGraph(graph: Graph) {
  const reversed = new Map<string, Set<string>>();
  for (const [from, targets] of graph.edges) {
    for (const target of targets) {
      if (!reversed.has(target)) reversed.set(target, new Set());
      reversed.get(target)!.add(from);
    }
  }
  return reversed;
}

function transitive(start: string, graph: Map<string, Set<string>>, limit = 200) {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0 && seen.size < limit) {
    const current = stack.pop()!;
    const next = graph.get(current);
    if (!next) continue;
    for (const item of next) {
      if (seen.has(item)) continue;
      seen.add(item);
      stack.push(item);
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
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    out.push({ file: match[1], line: Number(match[2]), text: match[3] });
  }
  return out;
}

function renameInSource(source: string, oldName: string, newName: string) {
  const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  let replaced = 0;
  const result = source.replace(re, () => {
    replaced += 1;
    return newName;
  });
  return { result, replaced };
}

async function pickTargetEcosystem(cwd: string, ecosystem?: Ecosystem['language'], packageName?: string) {
  const ecosystems = await scanEcosystems(cwd);
  const target =
    (ecosystem ? ecosystems.find(item => item.language === ecosystem) : null) ??
    ecosystems.find(item => (packageName ? item.packages.some(pkg => pkg.name === packageName) : false)) ??
    ecosystems[0];

  if (!target) throw new Error('no ecosystem detected');
  return { ecosystems, target };
}

async function auditCommand(cwd: string, language: Ecosystem['language']) {
  switch (language) {
    case 'typescript':
    case 'javascript': {
      const { cmd } = await detectInstaller(cwd);
      if (cmd.startsWith('bun')) return 'bun audit';
      if (cmd.startsWith('pnpm')) return 'pnpm audit';
      if (cmd.startsWith('yarn')) return 'yarn npm audit';
      return 'npm audit';
    }
    case 'python':
      return (await exists(join(cwd, 'uv.lock'))) ? 'uv pip list --outdated' : 'pip-audit || pip list --outdated';
    case 'rust':
      return 'cargo audit || cargo install cargo-audit --quiet && cargo audit';
    case 'go':
      return 'govulncheck ./...';
  }
}

async function verificationSteps(cwd: string, ecosystem?: Ecosystem['language'], typecheck = true) {
  const { target } = await pickTargetEcosystem(cwd, ecosystem);
  const steps: { name: string; cmd: string }[] = [];

  if (typecheck) {
    if (target.language === 'typescript') steps.push({ name: 'typecheck', cmd: 'npx tsc --noEmit' });
    else if (target.language === 'python') steps.push({ name: 'typecheck', cmd: 'mypy . 2>/dev/null || true' });
    else if (target.language === 'rust') steps.push({ name: 'typecheck', cmd: 'cargo check' });
    else if (target.language === 'go') steps.push({ name: 'typecheck', cmd: 'go vet ./...' });
  }

  switch (target.language) {
    case 'typescript':
    case 'javascript': {
      const installer = await detectInstaller(cwd);
      steps.push({ name: 'tests', cmd: installer.cmd.startsWith('bun') ? 'bun test' : 'npm test' });
      break;
    }
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

  return { target, steps };
}

export function createDepsScanTool(_: ToolFactoryOptions) {
  return tool({
    description: 'Inspect package manifests, lockfiles, package managers, and declared third-party dependencies in the current repository.',
    inputSchema: z.object({}),
    execute: async () => {
      const ecosystems = await scanEcosystems(process.cwd());
      return {
        ecosystems: ecosystems.map(ecosystem => ({
          language: ecosystem.language,
          manifest: ecosystem.manifest,
          lock: ecosystem.lock,
          installCmd: ecosystem.installCmd,
          packageCount: ecosystem.packages.length,
          packages: ecosystem.packages.slice(0, 200)
        }))
      };
    }
  });
}

export function createDepsImpactTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description: 'Analyze internal source-file dependency impact for one file. Use this to answer what imports this file and what this file depends on.',
    inputSchema: z.object({
      path: z.string(),
      limit: z.number().int().positive().max(500).optional()
    }),
    execute: async ({ path, limit }) => {
      const cwd = process.cwd();
      const graph = await getGraph(cwd, runUserShell);
      const target = resolve(cwd, path);
      const reversed = reverseGraph(graph);
      const importers = transitive(target, reversed, limit ?? 200).map(item => relative(cwd, item));
      const dependencies = transitive(target, graph.edges, limit ?? 200).map(item =>
        item.startsWith('pkg:') || item.startsWith('mod:') ? item : relative(cwd, item)
      );

      return {
        target: relative(cwd, target),
        graphBuiltAt: graph.builtAt,
        importerCount: importers.length,
        importers: importers.slice(0, 100),
        dependencyCount: dependencies.length,
        dependencies: dependencies.slice(0, 100)
      };
    }
  });
}

export function createDepsPackagesTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description: 'Inspect or modify external package dependencies. Use for bumping one package version or auditing third-party packages.',
    inputSchema: z.object({
      action: z.enum(['bump', 'audit']),
      ecosystem: z.enum(['typescript', 'javascript', 'python', 'rust', 'go']).optional(),
      packageName: z.string().optional(),
      version: z.string().optional(),
      kind: z.enum(['prod', 'dev']).optional(),
      skipInstall: z.boolean().optional()
    }),
    execute: async ({ action, ecosystem, packageName, version, kind, skipInstall }) => {
      const cwd = process.cwd();

      if (action === 'audit') {
        const { target } = await pickTargetEcosystem(cwd, ecosystem);
        const cmd = await auditCommand(cwd, target.language);
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

      if (!packageName || !version) throw new Error('bump requires `packageName` and `version`');
      const { target } = await pickTargetEcosystem(cwd, ecosystem, packageName);
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
      } else if (target.manifest === 'Cargo.toml' || target.manifest === 'pyproject.toml' || target.manifest === 'go.mod') {
        const re = new RegExp(`(^\\s*${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*")[^"]+(")`, 'm');
        if (!re.test(manifestText)) {
          throw new Error(`could not locate \`${packageName}\` in ${target.manifest}; manual edit needed`);
        }
        nextText = manifestText.replace(re, (_, start, end) => `${start}${version}${end}`);
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
        throw new Error('bump denied by user');
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
  });
}

export function createSymbolRenameTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description: 'Rename a simple identifier textually across the project. Use only for straightforward renames that can be validated with typecheck and tests.',
    inputSchema: z.object({
      symbol: z.string(),
      newName: z.string(),
      includeNodeModules: z.boolean().optional()
    }),
    execute: async ({ symbol, newName, includeNodeModules }) => {
      const cwd = process.cwd();
      if (!/^[A-Za-z_$][\w$]*$/.test(symbol) || !/^[A-Za-z_$][\w$]*$/.test(newName)) {
        throw new Error('symbol and newName must be simple identifiers');
      }

      const refs = await findSymbolReferences(symbol, cwd, runUserShell);
      const filtered = refs.filter(ref => includeNodeModules || !ref.file.includes('/node_modules/'));
      const byFile = new Map<string, number>();
      for (const ref of filtered) byFile.set(ref.file, (byFile.get(ref.file) ?? 0) + 1);
      const fileEntries = Array.from(byFile.entries()).sort((a, b) => b[1] - a[1]);

      if (fileEntries.length === 0) {
        return { renamed: 0, files: [], note: 'no references found' };
      }

      const previewLines = fileEntries.slice(0, 12).map(([file, count]) => `${count.toString().padStart(4)}× ${relative(cwd, file)}`);
      if (fileEntries.length > 12) {
        previewLines.push(`… ${fileEntries.length - 12} more file${fileEntries.length - 12 === 1 ? '' : 's'}`);
      }

      if (
        !(await requestApproval({
          scope: 'edit',
          title: 'Rename symbol across project',
          detail: `${symbol} → ${newName} · ${fileEntries.length} file${fileEntries.length === 1 ? '' : 's'}, ${filtered.length} reference${filtered.length === 1 ? '' : 's'}`,
          body: previewLines
        }))
      ) {
        throw new Error('symbol rename denied by user');
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
        totalReplacements: updated.reduce((sum, item) => sum + item.replaced, 0),
        updated,
        warning: 'textual rename only — run verify_changes next'
      };
    }
  });
}

export function createVerifyChangesTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description: 'Run repository verification after code, dependency, or rename changes. This runs typecheck first when available, then tests.',
    inputSchema: z.object({
      ecosystem: z.enum(['typescript', 'javascript', 'python', 'rust', 'go']).optional(),
      typecheck: z.boolean().optional()
    }),
    execute: async ({ ecosystem, typecheck }) => {
      const cwd = process.cwd();
      const { target, steps } = await verificationSteps(cwd, ecosystem, typecheck !== false);

      if (
        !(await requestApproval({
          scope: 'command',
          title: 'Verify changes',
          detail: steps.map(step => step.cmd).join(' && '),
          body: [`ecosystem: ${target.language}`, ...steps.map(step => `${step.name}: ${step.cmd}`)]
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

      return { ok: results.every(result => result.ok), ecosystem: target.language, results };
    }
  });
}
