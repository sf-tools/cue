import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { exists, readJsonSafe } from './utils';

export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'ruby'
  | 'php'
  | 'csharp'
  | 'shell'
  | 'sql'
  | 'markdown'
  | 'yaml'
  | 'json'
  | 'other';

export type SubsystemRole =
  | 'source'
  | 'tests'
  | 'scripts'
  | 'docs'
  | 'config'
  | 'infra'
  | 'ci'
  | 'migrations'
  | 'assets'
  | 'examples'
  | 'unknown';

export type SubsystemSummary = {
  path: string;
  role: SubsystemRole;
  file_count: number;
  total_bytes: number;
  languages: LanguageId[];
  sample_files: string[];
};

export type EntrypointSummary = {
  path: string;
  source: 'package.json' | 'pyproject.toml' | 'cargo.toml' | 'go.mod' | 'common-name';
  kind: 'bin' | 'main' | 'script' | 'module' | 'app';
  detail: string;
};

export type ConfigSummary = {
  path: string;
  kind:
    | 'typescript'
    | 'package'
    | 'lint'
    | 'format'
    | 'docker'
    | 'ci'
    | 'k8s'
    | 'terraform'
    | 'monorepo'
    | 'env'
    | 'other';
};

export type MapCodebaseResult = {
  root: string;
  total_files: number;
  total_source_bytes: number;
  language_breakdown: Array<{ language: LanguageId; files: number }>;
  subsystems: SubsystemSummary[];
  entrypoints: EntrypointSummary[];
  configs: ConfigSummary[];
  docs: string[];
  ecosystems: string[];
  summary: string;
  truncated: boolean;
};

const DEFAULT_MAX_SUBSYSTEMS = 12;
const DEFAULT_MAX_FILES_PER_SUBSYSTEM = 5;
const MAX_LIST_LIMIT = 64;
const FILE_LIST_CAP = 8000;

const EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.gradle',
  '.idea',
  '.vscode',
  '.DS_Store',
]);

const EXTENSION_TO_LANGUAGE: Record<string, LanguageId> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.sql': 'sql',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.rst': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.json5': 'json',
};

const COMMON_ENTRYPOINT_NAMES = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'index.mjs',
  'main.ts',
  'main.js',
  'main.py',
  'main.go',
  'main.rs',
  '__main__.py',
  'app.ts',
  'app.tsx',
  'app.js',
  'app.py',
  'server.ts',
  'server.js',
  'server.py',
  'cli.ts',
  'cli.js',
  'cli.py',
  'manage.py',
]);

const CONFIG_PATTERNS: Array<{ name: RegExp; kind: ConfigSummary['kind'] }> = [
  { name: /^tsconfig(\..+)?\.json$/, kind: 'typescript' },
  { name: /^package\.json$/, kind: 'package' },
  { name: /^pyproject\.toml$/, kind: 'package' },
  { name: /^cargo\.toml$/i, kind: 'package' },
  { name: /^go\.mod$/, kind: 'package' },
  { name: /^pnpm-workspace\.yaml$|^lerna\.json$|^nx\.json$|^turbo\.json$/, kind: 'monorepo' },
  { name: /^\.eslintrc(\..+)?$|^eslint\.config\..+$|^biome\.json$/, kind: 'lint' },
  { name: /^\.prettierrc(\..+)?$|^prettier\.config\..+$/, kind: 'format' },
  { name: /^dockerfile$|^\.dockerignore$|^docker-compose\..+$/i, kind: 'docker' },
  { name: /^\.env(\..+)?$/, kind: 'env' },
];

const DOC_NAMES = new Set([
  'readme.md',
  'readme.mdx',
  'readme.rst',
  'readme.txt',
  'architecture.md',
  'design.md',
  'contributing.md',
  'changelog.md',
  'docs.md',
]);

function classifyExtension(name: string): LanguageId {
  const ext = extname(name).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? 'other';
}

function classifyRole(relativePath: string): SubsystemRole {
  const p = relativePath.toLowerCase().replace(/\\/g, '/');
  if (/(^|\/)(__tests__|tests?|spec|specs?|e2e)(\/|$)/.test(p)) return 'tests';
  if (/(^|\/)scripts?(\/|$)/.test(p)) return 'scripts';
  if (/(^|\/)docs?(\/|$)/.test(p)) return 'docs';
  if (/(^|\/)examples?(\/|$)/.test(p)) return 'examples';
  if (/(^|\/)(migrations?|db\/migrations?|prisma\/migrations?|alembic)(\/|$)/.test(p))
    return 'migrations';
  if (
    /(^|\/)(deploy|deployment|infra|infrastructure|terraform|k8s|kubernetes|helm|charts?)(\/|$)/.test(
      p,
    )
  )
    return 'infra';
  if (/(^|\/)(\.github|\.gitlab|\.circleci|ci|\.buildkite)(\/|$)/.test(p)) return 'ci';
  if (
    /(^|\/)(assets?|public|static|images?|fonts?)(\/|$)/.test(p) ||
    /\.(png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|otf|eot)$/.test(p)
  )
    return 'assets';
  if (/(^|\/)(config|configs)(\/|$)/.test(p)) return 'config';
  if (/(^|\/)(src|lib|app|server|client|packages?|cmd|internal|pkg)(\/|$)/.test(p)) return 'source';
  return 'unknown';
}

async function listFilesRipgrep(
  cwd: string,
  runUserShell: ToolFactoryOptions['runUserShell'],
): Promise<string[] | null> {
  const args = [
    '--files',
    '--hidden',
    '--no-ignore-vcs',
    "-g '!**/node_modules/**'",
    "-g '!**/.git/**'",
    "-g '!**/dist/**'",
    "-g '!**/build/**'",
    "-g '!**/target/**'",
    "-g '!**/.next/**'",
    "-g '!**/coverage/**'",
    "-g '!**/.venv/**'",
    "-g '!**/venv/**'",
    "-g '!**/__pycache__/**'",
  ];
  const cmd = `if command -v rg >/dev/null 2>&1; then command rg ${args.join(' ')} ${JSON.stringify(cwd)}; else echo __NO_RG__; fi`;
  const { output, exitCode } = await runUserShell(cmd);
  const text = plain(output).trim();
  if (text === '__NO_RG__' || (exitCode !== 0 && exitCode !== 1)) return null;
  return text.split('\n').filter(Boolean);
}

async function listFilesNodeFs(cwd: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= FILE_LIST_CAP) return;
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile()) out.push(full);
    }
  };
  await walk(cwd);
  return out;
}

async function listFiles(cwd: string, runUserShell: ToolFactoryOptions['runUserShell']) {
  const ripgrep = await listFilesRipgrep(cwd, runUserShell).catch(() => null);
  if (ripgrep && ripgrep.length > 0) return ripgrep.slice(0, FILE_LIST_CAP);
  return listFilesNodeFs(cwd);
}

async function safeStatSize(path: string) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

const NESTED_TOP_DIRS = new Set(['src', 'lib', 'packages', 'app']);

function topLevelKey(relativePath: string) {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length === 0) return '.';
  if (parts.length === 1) return parts[0]!;
  if (NESTED_TOP_DIRS.has(parts[0]!) && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0]!;
}

async function detectEntrypoints(cwd: string, files: string[]): Promise<EntrypointSummary[]> {
  const out: EntrypointSummary[] = [];
  const seen = new Set<string>();
  const push = (entry: EntrypointSummary) => {
    const key = `${entry.source}:${entry.path}:${entry.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  const pkgJson = (await readJsonSafe(join(cwd, 'package.json'))) as {
    bin?: string | Record<string, string>;
    main?: string;
    module?: string;
    scripts?: Record<string, string>;
  } | null;

  if (pkgJson) {
    if (typeof pkgJson.bin === 'string') {
      push({ path: pkgJson.bin, source: 'package.json', kind: 'bin', detail: 'package.bin' });
    } else if (pkgJson.bin && typeof pkgJson.bin === 'object') {
      for (const [name, target] of Object.entries(pkgJson.bin)) {
        push({ path: target, source: 'package.json', kind: 'bin', detail: `bin: ${name}` });
      }
    }
    if (pkgJson.main) {
      push({ path: pkgJson.main, source: 'package.json', kind: 'main', detail: 'package.main' });
    }
    if (pkgJson.module) {
      push({
        path: pkgJson.module,
        source: 'package.json',
        kind: 'module',
        detail: 'package.module',
      });
    }
    if (pkgJson.scripts) {
      for (const [name, value] of Object.entries(pkgJson.scripts)) {
        if (/^(start|dev|build|serve)$/.test(name)) {
          push({
            path: name,
            source: 'package.json',
            kind: 'script',
            detail: `npm script: ${name} -> ${value}`,
          });
        }
      }
    }
  }

  if (await exists(join(cwd, 'pyproject.toml'))) {
    const text = await readFile(join(cwd, 'pyproject.toml'), 'utf8').catch(() => '');
    const scriptsBlock = text.match(/\[(?:project|tool\.poetry)\.scripts\]([\s\S]*?)(?=^\[|\Z)/m);
    if (scriptsBlock) {
      for (const match of scriptsBlock[1]!.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/gm)) {
        push({
          path: match[2]!,
          source: 'pyproject.toml',
          kind: 'bin',
          detail: `script: ${match[1]}`,
        });
      }
    }
  }

  if (await exists(join(cwd, 'Cargo.toml'))) {
    const text = await readFile(join(cwd, 'Cargo.toml'), 'utf8').catch(() => '');
    const binBlocks = text.matchAll(/\[\[bin\]\]([\s\S]*?)(?=^\[|\Z)/gm);
    for (const block of binBlocks) {
      const path = block[1]!.match(/^\s*path\s*=\s*"([^"]+)"/m)?.[1];
      const name = block[1]!.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? 'bin';
      if (path) push({ path, source: 'cargo.toml', kind: 'bin', detail: `cargo bin: ${name}` });
    }
  }

  if (await exists(join(cwd, 'go.mod'))) {
    const goMain = files.find(f => /(^|\/)cmd\/[^/]+\/main\.go$|(^|\/)main\.go$/.test(f));
    if (goMain) {
      push({ path: relative(cwd, goMain), source: 'go.mod', kind: 'app', detail: 'go main' });
    }
  }

  for (const file of files) {
    const rel = relative(cwd, file);
    const name = basename(file).toLowerCase();
    if (COMMON_ENTRYPOINT_NAMES.has(name)) {
      const depth = rel.split('/').length;
      if (depth <= 3) {
        push({
          path: rel,
          source: 'common-name',
          kind: 'app',
          detail: `well-known entrypoint name`,
        });
      }
    }
  }

  return out;
}

function detectConfigs(files: string[]): ConfigSummary[] {
  const out: ConfigSummary[] = [];
  for (const file of files) {
    const name = basename(file).toLowerCase();
    for (const pattern of CONFIG_PATTERNS) {
      if (pattern.name.test(name)) {
        out.push({ path: file, kind: pattern.kind });
        break;
      }
    }
    if (/\/\.github\/workflows\/[^/]+\.ya?ml$/i.test(file)) {
      out.push({ path: file, kind: 'ci' });
    }
    if (/\.tf$|\/terraform\//i.test(file)) {
      out.push({ path: file, kind: 'terraform' });
    }
    if (/\/(k8s|kubernetes|helm|charts?)\//i.test(file)) {
      out.push({ path: file, kind: 'k8s' });
    }
  }
  return out;
}

function detectDocs(files: string[]) {
  const docs: string[] = [];
  for (const file of files) {
    const name = basename(file).toLowerCase();
    if (DOC_NAMES.has(name)) docs.push(file);
    else if (/\/docs?\/.*\.(md|mdx|rst)$/i.test(file)) docs.push(file);
  }
  return docs;
}

async function detectEcosystems(cwd: string) {
  const out: string[] = [];
  if (await exists(join(cwd, 'package.json'))) out.push('node');
  if (await exists(join(cwd, 'pyproject.toml'))) out.push('python');
  if (await exists(join(cwd, 'Cargo.toml'))) out.push('rust');
  if (await exists(join(cwd, 'go.mod'))) out.push('go');
  if (await exists(join(cwd, 'pom.xml')) || (await exists(join(cwd, 'build.gradle'))))
    out.push('jvm');
  if (await exists(join(cwd, 'Gemfile'))) out.push('ruby');
  if (await exists(join(cwd, 'composer.json'))) out.push('php');
  return out;
}

export async function buildCodebaseMap(
  cwd: string,
  runUserShell: ToolFactoryOptions['runUserShell'],
  options: {
    maxSubsystems?: number;
    maxFilesPerSubsystem?: number;
  } = {},
): Promise<MapCodebaseResult> {
  const root = resolve(cwd);
  const allFiles = await listFiles(root, runUserShell);
  const truncated = allFiles.length >= FILE_LIST_CAP;

  const subsystemMap = new Map<
    string,
    {
      path: string;
      role: SubsystemRole;
      file_count: number;
      total_bytes: number;
      languages: Map<LanguageId, number>;
      sample_files: string[];
    }
  >();
  const langCount = new Map<LanguageId, number>();
  let totalBytes = 0;

  const sizes = await Promise.all(allFiles.map(file => safeStatSize(file)));

  for (let index = 0; index < allFiles.length; index += 1) {
    const file = allFiles[index]!;
    const rel = relative(root, file);
    if (!rel || rel.startsWith('..')) continue;
    const lang = classifyExtension(file);
    langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
    totalBytes += sizes[index] ?? 0;

    const key = topLevelKey(rel);
    const role = classifyRole(rel);
    const bucket = subsystemMap.get(key) ?? {
      path: key,
      role,
      file_count: 0,
      total_bytes: 0,
      languages: new Map<LanguageId, number>(),
      sample_files: [],
    };
    bucket.role = bucket.role === 'unknown' ? role : bucket.role;
    bucket.file_count += 1;
    bucket.total_bytes += sizes[index] ?? 0;
    bucket.languages.set(lang, (bucket.languages.get(lang) ?? 0) + 1);
    if (bucket.sample_files.length < (options.maxFilesPerSubsystem ?? DEFAULT_MAX_FILES_PER_SUBSYSTEM)) {
      bucket.sample_files.push(rel);
    }
    subsystemMap.set(key, bucket);
  }

  const subsystems: SubsystemSummary[] = Array.from(subsystemMap.values())
    .sort((a, b) => b.file_count - a.file_count || a.path.localeCompare(b.path))
    .slice(0, options.maxSubsystems ?? DEFAULT_MAX_SUBSYSTEMS)
    .map(bucket => ({
      path: bucket.path,
      role: bucket.role,
      file_count: bucket.file_count,
      total_bytes: bucket.total_bytes,
      languages: Array.from(bucket.languages.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([language]) => language),
      sample_files: bucket.sample_files,
    }));

  const entrypoints = await detectEntrypoints(root, allFiles);
  const configs = detectConfigs(allFiles).map(item => ({
    ...item,
    path: relative(root, item.path) || item.path,
  }));
  const docs = detectDocs(allFiles).map(file => relative(root, file) || file);
  const ecosystems = await detectEcosystems(root);

  const language_breakdown = Array.from(langCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([language, files]) => ({ language, files }));

  const topLanguages = language_breakdown
    .slice(0, 3)
    .map(item => `${item.language} (${item.files})`)
    .join(', ');
  const subsystemPaths = subsystems
    .slice(0, 5)
    .map(item => `${item.path} [${item.role}, ${item.file_count} files]`)
    .join('; ');
  const summary =
    `${allFiles.length} tracked files across ${subsystemMap.size} top-level area(s). ` +
    `Ecosystems: ${ecosystems.length ? ecosystems.join(', ') : 'unknown'}. ` +
    `Top languages: ${topLanguages || 'unknown'}. ` +
    `Major subsystems: ${subsystemPaths || 'none detected'}. ` +
    `${entrypoints.length} entrypoint(s), ${configs.length} config file(s), ${docs.length} doc(s).`;

  return {
    root,
    total_files: allFiles.length,
    total_source_bytes: totalBytes,
    language_breakdown,
    subsystems,
    entrypoints,
    configs,
    docs,
    ecosystems,
    summary,
    truncated,
  };
}

export function createMapCodebaseTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Map the repository structure: subsystems, languages, entrypoints, configs, and docs. Use to orient before planning changes.',
    inputSchema: z.object({
      root: z.string().nullable().optional(),
      max_subsystems: z.number().int().positive().max(MAX_LIST_LIMIT).nullable().optional(),
      max_files_per_subsystem: z
        .number()
        .int()
        .positive()
        .max(MAX_LIST_LIMIT)
        .nullable()
        .optional(),
    }),
    execute: async ({ root, max_subsystems, max_files_per_subsystem }) => {
      const cwd = resolve(root ?? process.cwd());
      return buildCodebaseMap(cwd, runUserShell, {
        maxSubsystems: max_subsystems ?? DEFAULT_MAX_SUBSYSTEMS,
        maxFilesPerSubsystem: max_files_per_subsystem ?? DEFAULT_MAX_FILES_PER_SUBSYSTEM,
      });
    },
  });
}
