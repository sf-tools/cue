import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, basename, extname, join, relative, resolve } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { exists, readJsonSafe, truncate } from './utils';

type Language = 'typescript' | 'javascript' | 'python' | 'rust' | 'go' | 'unknown';
type Framework =
  | 'vitest'
  | 'jest'
  | 'mocha'
  | 'bun:test'
  | 'pytest'
  | 'cargo-test'
  | 'go-test'
  | 'unknown';

type FrameworkInfo = {
  language: Language;
  framework: Framework;
  runCmd: string;
  bailFlag: string | null;
  testGlob: string;
  testFileSuffix: string;
  conventionalDir: string | null;
  notes: string[];
};

type SymbolInfo = {
  kind: string;
  name: string;
  line: number;
  signature: string;
};

type Branch = {
  kind: string;
  line: number;
  text: string;
};

type AnalyzeResult = {
  path: string;
  language: Language;
  loc: number;
  exports: SymbolInfo[];
  branches: Branch[];
  asyncCount: number;
  throwCount: number;
  callers: string[];
  existingTests: string[];
  suggestedCases: { name: string; kind: 'happy' | 'edge' | 'error'; rationale: string }[];
};

async function detectFramework(cwd: string): Promise<FrameworkInfo> {
  const pkg = await readJsonSafe(join(cwd, 'package.json'));
  if (pkg) {
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    const isTs = !!deps.typescript || (await exists(join(cwd, 'tsconfig.json')));
    const language: Language = isTs ? 'typescript' : 'javascript';

    if (deps.vitest) {
      return {
        language,
        framework: 'vitest',
        runCmd: 'npx vitest run',
        bailFlag: '--bail=1',
        testGlob: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        testFileSuffix: '.test',
        conventionalDir: null,
        notes: ['detected vitest in package.json'],
      };
    }

    if (deps.jest) {
      return {
        language,
        framework: 'jest',
        runCmd: 'npx jest',
        bailFlag: '--bail',
        testGlob: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        testFileSuffix: '.test',
        conventionalDir: '__tests__',
        notes: ['detected jest in package.json'],
      };
    }

    if (deps.mocha) {
      return {
        language,
        framework: 'mocha',
        runCmd: 'npx mocha',
        bailFlag: '--bail',
        testGlob: 'test/**/*.{ts,js}',
        testFileSuffix: '.test',
        conventionalDir: 'test',
        notes: ['detected mocha in package.json'],
      };
    }

    if (await exists(join(cwd, 'bun.lock'))) {
      return {
        language,
        framework: 'bun:test',
        runCmd: 'bun test',
        bailFlag: '--bail',
        testGlob: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        testFileSuffix: '.test',
        conventionalDir: null,
        notes: ['no JS test framework declared; falling back to bun:test (bun.lock present)'],
      };
    }

    const scriptTest = (pkg.scripts as Record<string, string> | undefined)?.test;
    if (scriptTest) {
      return {
        language,
        framework: 'unknown',
        runCmd: 'npm test',
        bailFlag: null,
        testGlob: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        testFileSuffix: '.test',
        conventionalDir: null,
        notes: [`fell back to package.json scripts.test: ${scriptTest}`],
      };
    }
  }

  if (
    (await exists(join(cwd, 'pyproject.toml'))) ||
    (await exists(join(cwd, 'pytest.ini'))) ||
    (await exists(join(cwd, 'setup.cfg')))
  ) {
    return {
      language: 'python',
      framework: 'pytest',
      runCmd: 'pytest',
      bailFlag: '-x',
      testGlob: 'tests/**/test_*.py',
      testFileSuffix: '_test',
      conventionalDir: 'tests',
      notes: ['detected python project; assuming pytest'],
    };
  }

  if (await exists(join(cwd, 'Cargo.toml'))) {
    return {
      language: 'rust',
      framework: 'cargo-test',
      runCmd: 'cargo test',
      bailFlag: null,
      testGlob: '**/*.rs',
      testFileSuffix: '',
      conventionalDir: 'tests',
      notes: ['detected Cargo.toml; using cargo test'],
    };
  }

  if (await exists(join(cwd, 'go.mod'))) {
    return {
      language: 'go',
      framework: 'go-test',
      runCmd: 'go test ./...',
      bailFlag: '-failfast',
      testGlob: '**/*_test.go',
      testFileSuffix: '_test',
      conventionalDir: null,
      notes: ['detected go.mod; using go test'],
    };
  }

  return {
    language: 'unknown',
    framework: 'unknown',
    runCmd: '',
    bailFlag: null,
    testGlob: '',
    testFileSuffix: '',
    conventionalDir: null,
    notes: ['no recognized project files found'],
  };
}

function languageFromPath(path: string): Language {
  const ext = extname(path).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  return 'unknown';
}

function extractSymbolsTsJs(source: string): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match = line.match(/^export\s+(?:default\s+)?async\s+function\s+(\w+)\s*\(([^)]*)\)/);
    if (match) {
      out.push({ kind: 'async function', name: match[1], line: index + 1, signature: line.trim() });
      continue;
    }

    match = line.match(/^export\s+(?:default\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
    if (match) {
      out.push({ kind: 'function', name: match[1], line: index + 1, signature: line.trim() });
      continue;
    }

    match = line.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
    if (match) {
      out.push({ kind: 'class', name: match[1], line: index + 1, signature: line.trim() });
      continue;
    }

    match = line.match(/^export\s+const\s+(\w+)\s*[:=]/);
    if (match) {
      out.push({ kind: 'const', name: match[1], line: index + 1, signature: line.trim() });
      continue;
    }

    match = line.match(/^export\s+(?:type|interface)\s+(\w+)/);
    if (match) out.push({ kind: 'type', name: match[1], line: index + 1, signature: line.trim() });
  }
  return out;
}

function extractSymbolsPython(source: string): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^def\s+\w+/.test(line)) {
      const match = line.match(/^def\s+(\w+)/);
      if (match)
        out.push({ kind: 'function', name: match[1], line: index + 1, signature: line.trim() });
    } else if (/^async\s+def\s+\w+/.test(line)) {
      const match = line.match(/^async\s+def\s+(\w+)/);
      if (match)
        out.push({
          kind: 'async function',
          name: match[1],
          line: index + 1,
          signature: line.trim(),
        });
    } else if (/^class\s+\w+/.test(line)) {
      const match = line.match(/^class\s+(\w+)/);
      if (match)
        out.push({ kind: 'class', name: match[1], line: index + 1, signature: line.trim() });
    }
  }
  return out;
}

function extractSymbolsGo(source: string): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/);
    if (match)
      out.push({
        kind: 'function',
        name: match[1],
        line: index + 1,
        signature: lines[index].trim(),
      });
  }
  return out;
}

function extractSymbolsRust(source: string): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)/);
    if (match)
      out.push({
        kind: match[0].includes('fn') ? 'function' : 'type',
        name: match[1],
        line: index + 1,
        signature: lines[index].trim(),
      });
  }
  return out;
}

function extractSymbols(source: string, language: Language): SymbolInfo[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractSymbolsTsJs(source);
    case 'python':
      return extractSymbolsPython(source);
    case 'go':
      return extractSymbolsGo(source);
    case 'rust':
      return extractSymbolsRust(source);
    default:
      return [];
  }
}

function extractBranches(
  source: string,
  language: Language,
): { branches: Branch[]; asyncCount: number; throwCount: number } {
  const branches: Branch[] = [];
  const lines = source.split('\n');
  let asyncCount = 0;
  let throwCount = 0;

  const isPy = language === 'python';
  const isRs = language === 'rust';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^\s*(if|elif|else if)\b/.test(line))
      branches.push({ kind: 'if', line: index + 1, text: trimmed });
    if (/^\s*(switch|match)\b/.test(line))
      branches.push({ kind: 'switch', line: index + 1, text: trimmed });
    if (/^\s*case\s+/.test(line)) branches.push({ kind: 'case', line: index + 1, text: trimmed });
    if (/^\s*(try|except|catch)\b/.test(line))
      branches.push({ kind: 'try', line: index + 1, text: trimmed });

    if (
      /\bthrow\b/.test(line) ||
      (isPy && /\braise\b/.test(line)) ||
      (isRs && /\.unwrap\(\)|\.expect\(/.test(line))
    ) {
      throwCount += 1;
    }
    if (/\basync\b/.test(line)) asyncCount += 1;
  }

  return { branches, asyncCount, throwCount };
}

function suggestCases(
  symbols: SymbolInfo[],
  branches: Branch[],
  throwCount: number,
): AnalyzeResult['suggestedCases'] {
  const cases: AnalyzeResult['suggestedCases'] = [];
  for (const symbol of symbols.slice(0, 8)) {
    if (symbol.kind === 'type') continue;
    cases.push({
      name: `${symbol.name}: happy path`,
      kind: 'happy',
      rationale: 'representative valid input matching the signature',
    });
    cases.push({
      name: `${symbol.name}: empty/null input`,
      kind: 'edge',
      rationale: 'boundary inputs (empty string/array/null/undefined)',
    });
    cases.push({
      name: `${symbol.name}: large input`,
      kind: 'edge',
      rationale: 'stress with large/long input to surface perf or overflow issues',
    });
    if (throwCount > 0) {
      cases.push({
        name: `${symbol.name}: invalid input throws`,
        kind: 'error',
        rationale: 'function contains throw/raise; verify error path',
      });
    }
    if (symbol.kind === 'async function') {
      cases.push({
        name: `${symbol.name}: rejected promise`,
        kind: 'error',
        rationale: 'async function — verify rejection propagates',
      });
    }
  }

  for (const branch of branches.slice(0, 4)) {
    cases.push({
      name: `branch at line ${branch.line} (${branch.kind})`,
      kind: 'edge',
      rationale: `cover branch: ${branch.text.slice(0, 80)}`,
    });
  }

  return cases.slice(0, 16);
}

async function findCallers(
  symbolNames: string[],
  cwd: string,
  runUserShell: ToolFactoryOptions['runUserShell'],
) {
  if (symbolNames.length === 0) return [];
  const pattern = symbolNames.map(name => `\\b${name}\\b`).join('|');
  const { output } = await runUserShell(
    `if command -v rg >/dev/null 2>&1; then command rg --line-number --no-heading --color=never -e ${JSON.stringify(pattern)} ${JSON.stringify(cwd)} 2>/dev/null | head -n 80; else true; fi`,
  );
  return plain(output).trim().split('\n').filter(Boolean).slice(0, 40);
}

async function findExistingTests(
  targetPath: string,
  runUserShell: ToolFactoryOptions['runUserShell'],
) {
  const base = basename(targetPath, extname(targetPath));
  const { output } = await runUserShell(
    `if command -v rg >/dev/null 2>&1; then command rg --files -g '*.{test,spec,_test}.*' -g '**/test_*.py' 2>/dev/null | command rg ${JSON.stringify(base)} | head -n 20; else true; fi`,
  );
  return plain(output).trim().split('\n').filter(Boolean);
}

function suggestTestPath(targetPath: string, info: FrameworkInfo): string {
  const dir = dirname(targetPath);
  const ext = extname(targetPath);
  const base = basename(targetPath, ext);
  if (info.framework === 'pytest') return join('tests', `test_${base}.py`);
  if (info.framework === 'go-test') return join(dir, `${base}_test.go`);
  if (info.framework === 'cargo-test') return join('tests', `${base}_test.rs`);
  if (info.framework === 'jest' && info.conventionalDir === '__tests__')
    return join(dir, '__tests__', `${base}.test${ext}`);
  return join(dir, `${base}.test${ext}`);
}

async function analyzePath(
  path: string,
  cwd: string,
  runUserShell: ToolFactoryOptions['runUserShell'],
): Promise<AnalyzeResult> {
  const source = await readFile(path, 'utf8');
  const language = languageFromPath(path);
  const symbols = extractSymbols(source, language);
  const { branches, asyncCount, throwCount } = extractBranches(source, language);
  const callers = await findCallers(
    symbols.map(symbol => symbol.name),
    cwd,
    runUserShell,
  );
  const existingTests = await findExistingTests(path, runUserShell);

  return {
    path: relative(cwd, resolve(path)),
    language,
    loc: source.split('\n').length,
    exports: symbols,
    branches: branches.slice(0, 30),
    asyncCount,
    throwCount,
    callers,
    existingTests,
    suggestedCases: suggestCases(symbols, branches, throwCount),
  };
}

function buildTestCommand(info: FrameworkInfo, pattern?: string, bail?: boolean) {
  if (!info.runCmd) {
    throw new Error('no test framework detected; use test_detect first');
  }

  const parts = [info.runCmd];
  if (bail !== false && info.bailFlag) parts.push(info.bailFlag);
  if (pattern) parts.push(JSON.stringify(pattern));
  return parts.join(' ');
}

export function createTestDetectTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Detect the repository test framework, language, test file conventions, and default test command.',
    inputSchema: z.object({}),
    execute: async () => await detectFramework(process.cwd()),
  });
}

export function createTestAnalyzeTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Analyze one source file to suggest test cases, exported symbols, branches, callers, and likely existing tests.',
    inputSchema: z.object({
      path: z.string(),
    }),
    execute: async ({ path }) => await analyzePath(path, process.cwd(), runUserShell),
  });
}

export function createTestScaffoldTool({ requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Write a new test file for a source file using test content you provide. The tool picks the conventional test path for the repo.',
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
    }),
    execute: async ({ path, content }) => {
      const cwd = process.cwd();
      const info = await detectFramework(cwd);
      const testPath = suggestTestPath(path, info);

      if (
        !(await requestApproval({
          scope: 'edit',
          title: 'Scaffold test file',
          detail: `${testPath} · ${content.length} bytes (framework: ${info.framework})`,
          body: content.split('\n').slice(0, 8),
        }))
      ) {
        throw new Error('scaffold denied by user');
      }

      await mkdir(dirname(testPath), { recursive: true });
      await writeFile(testPath, content);
      return { wrote: testPath, framework: info.framework, runCmd: info.runCmd };
    },
  });
}

export function createTestRunTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Run the repository test command. Prefer this over bash for normal test execution because it detects the right framework and flags.',
    inputSchema: z.object({
      pattern: z.string().optional(),
      bail: z.boolean().optional(),
    }),
    execute: async ({ pattern, bail }) => {
      const info = await detectFramework(process.cwd());
      const cmd = buildTestCommand(info, pattern, bail);

      if (
        !(await requestApproval({
          scope: 'command',
          title: 'Run tests',
          detail: cmd,
          body: [
            `framework: ${info.framework}`,
            `bail: ${bail !== false && info.bailFlag ? 'on' : 'off'}`,
          ],
        }))
      ) {
        throw new Error('test run denied by user');
      }

      const { output, exitCode } = await runUserShell(cmd);
      const text = truncate(plain(output).trimEnd());
      return {
        framework: info.framework,
        cmd,
        exitCode,
        passed: exitCode === 0,
        output: text || '(no output)',
      };
    },
  });
}
