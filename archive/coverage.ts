import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { exists, readJsonSafe, truncate } from './utils';

type CoverageEcosystem = 'vitest' | 'jest' | 'pytest' | 'go' | 'cargo' | 'unknown';

type FileCoverage = {
  path: string;
  statements?: { covered: number; total: number; pct: number };
  branches?: { covered: number; total: number; pct: number };
  lines?: { covered: number; total: number; pct: number };
  functions?: { covered: number; total: number; pct: number };
  uncoveredLines: number[];
};

type CoverageReport = {
  ecosystem: CoverageEcosystem;
  totals: {
    statements?: { covered: number; total: number; pct: number };
    lines?: { covered: number; total: number; pct: number };
    branches?: { covered: number; total: number; pct: number };
    functions?: { covered: number; total: number; pct: number };
  };
  files: FileCoverage[];
};

type Detection = {
  ecosystem: CoverageEcosystem;
  runCmd: string;
  reportPath: string;
  parser: 'istanbul-summary' | 'istanbul-final' | 'pytest-coverage' | 'go-cover' | 'cargo-llvm-cov' | 'cargo-tarpaulin';
  notes: string[];
};

async function detectCoverage(cwd: string): Promise<Detection> {
  const pkg = await readJsonSafe(join(cwd, 'package.json'));
  if (pkg) {
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined)
    };
    if (deps.vitest) {
      return {
        ecosystem: 'vitest',
        runCmd: 'npx vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=json --coverage.reportsDirectory=coverage',
        reportPath: 'coverage/coverage-summary.json',
        parser: 'istanbul-summary',
        notes: ['detected vitest']
      };
    }
    if (deps.jest) {
      return {
        ecosystem: 'jest',
        runCmd: 'npx jest --coverage --coverageReporters=json-summary --coverageReporters=json --coverageDirectory=coverage',
        reportPath: 'coverage/coverage-summary.json',
        parser: 'istanbul-summary',
        notes: ['detected jest']
      };
    }
  }

  if ((await exists(join(cwd, 'pyproject.toml'))) || (await exists(join(cwd, 'requirements.txt')))) {
    return {
      ecosystem: 'pytest',
      runCmd: 'pytest --cov=. --cov-report=json:coverage.json --cov-report=term',
      reportPath: 'coverage.json',
      parser: 'pytest-coverage',
      notes: ['detected python project; using pytest-cov']
    };
  }

  if (await exists(join(cwd, 'go.mod'))) {
    return {
      ecosystem: 'go',
      runCmd: 'go test -coverprofile=coverage.out ./... && go tool cover -func=coverage.out',
      reportPath: 'coverage.out',
      parser: 'go-cover',
      notes: ['detected go module']
    };
  }

  if (await exists(join(cwd, 'Cargo.toml'))) {
    return {
      ecosystem: 'cargo',
      runCmd: 'cargo llvm-cov --json --output-path coverage.json',
      reportPath: 'coverage.json',
      parser: 'cargo-llvm-cov',
      notes: ['detected cargo project; requires cargo-llvm-cov (cargo install cargo-llvm-cov)']
    };
  }

  return {
    ecosystem: 'unknown',
    runCmd: '',
    reportPath: '',
    parser: 'istanbul-summary',
    notes: ['unable to detect coverage tooling']
  };
}

type IstanbulSummary = {
  total?: Record<string, { total: number; covered: number; pct: number; skipped?: number }>;
  [path: string]: Record<string, { total: number; covered: number; pct: number; skipped?: number }> | undefined;
};

function parseIstanbulSummary(json: IstanbulSummary, cwd: string): CoverageReport {
  const files: FileCoverage[] = [];
  for (const [key, metrics] of Object.entries(json)) {
    if (!metrics || key === 'total') continue;
    const rel = isAbsolute(key) ? relative(cwd, key) : key;
    files.push({
      path: rel,
      statements: metrics.statements && { covered: metrics.statements.covered, total: metrics.statements.total, pct: metrics.statements.pct },
      branches: metrics.branches && { covered: metrics.branches.covered, total: metrics.branches.total, pct: metrics.branches.pct },
      lines: metrics.lines && { covered: metrics.lines.covered, total: metrics.lines.total, pct: metrics.lines.pct },
      functions: metrics.functions && { covered: metrics.functions.covered, total: metrics.functions.total, pct: metrics.functions.pct },
      uncoveredLines: []
    });
  }
  return {
    ecosystem: 'unknown',
    totals: {
      statements: json.total?.statements && { covered: json.total.statements.covered, total: json.total.statements.total, pct: json.total.statements.pct },
      branches: json.total?.branches && { covered: json.total.branches.covered, total: json.total.branches.total, pct: json.total.branches.pct },
      lines: json.total?.lines && { covered: json.total.lines.covered, total: json.total.lines.total, pct: json.total.lines.pct },
      functions: json.total?.functions && { covered: json.total.functions.covered, total: json.total.functions.total, pct: json.total.functions.pct }
    },
    files
  };
}

type IstanbulFinal = Record<string, {
  path: string;
  statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
  s: Record<string, number>;
}>;

function uncoveredLinesFromIstanbulFinal(json: IstanbulFinal, target: string, cwd: string): number[] {
  const targetAbs = resolve(cwd, target);
  for (const fileData of Object.values(json)) {
    if (!fileData?.path) continue;
    if (fileData.path === targetAbs || relative(cwd, fileData.path) === target) {
      const uncovered = new Set<number>();
      for (const [id, count] of Object.entries(fileData.s)) {
        if (count !== 0) continue;
        const stmt = fileData.statementMap[id];
        if (!stmt) continue;
        for (let line = stmt.start.line; line <= stmt.end.line; line++) uncovered.add(line);
      }
      return Array.from(uncovered).sort((a, b) => a - b);
    }
  }
  return [];
}

type PytestCoverage = {
  totals: { covered_lines: number; num_statements: number; percent_covered: number; missing_lines: number };
  files: Record<string, {
    summary: { covered_lines: number; num_statements: number; percent_covered: number; missing_lines: number };
    missing_lines: number[];
  }>;
};

function parsePytestCoverage(json: PytestCoverage): CoverageReport {
  const files: FileCoverage[] = Object.entries(json.files ?? {}).map(([path, data]) => ({
    path,
    lines: { covered: data.summary.covered_lines, total: data.summary.num_statements, pct: data.summary.percent_covered },
    statements: { covered: data.summary.covered_lines, total: data.summary.num_statements, pct: data.summary.percent_covered },
    uncoveredLines: data.missing_lines ?? []
  }));
  return {
    ecosystem: 'pytest',
    totals: {
      lines: { covered: json.totals.covered_lines, total: json.totals.num_statements, pct: json.totals.percent_covered },
      statements: { covered: json.totals.covered_lines, total: json.totals.num_statements, pct: json.totals.percent_covered }
    },
    files
  };
}

function parseGoCover(text: string, cwd: string): CoverageReport {
  // mode: set/atomic/count
  // file:startLine.startCol,endLine.endCol numStatements count
  const fileMap = new Map<string, { covered: number; total: number; uncovered: Set<number> }>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('mode:')) continue;
    const match = /^(.+?):(\d+)\.\d+,(\d+)\.\d+\s+(\d+)\s+(\d+)$/.exec(line);
    if (!match) continue;
    const [, file, startLine, endLine, numStmtRaw, countRaw] = match;
    const numStmt = Number(numStmtRaw);
    const count = Number(countRaw);
    const rel = isAbsolute(file) ? relative(cwd, file) : file;
    const entry = fileMap.get(rel) ?? { covered: 0, total: 0, uncovered: new Set<number>() };
    entry.total += numStmt;
    if (count > 0) entry.covered += numStmt;
    else for (let l = Number(startLine); l <= Number(endLine); l++) entry.uncovered.add(l);
    fileMap.set(rel, entry);
  }

  let totalCovered = 0;
  let totalStmts = 0;
  const files: FileCoverage[] = [];
  for (const [path, entry] of fileMap) {
    totalCovered += entry.covered;
    totalStmts += entry.total;
    const pct = entry.total === 0 ? 100 : (entry.covered / entry.total) * 100;
    files.push({
      path,
      statements: { covered: entry.covered, total: entry.total, pct },
      lines: { covered: entry.covered, total: entry.total, pct },
      uncoveredLines: Array.from(entry.uncovered).sort((a, b) => a - b)
    });
  }

  const totalPct = totalStmts === 0 ? 100 : (totalCovered / totalStmts) * 100;
  return {
    ecosystem: 'go',
    totals: { statements: { covered: totalCovered, total: totalStmts, pct: totalPct }, lines: { covered: totalCovered, total: totalStmts, pct: totalPct } },
    files
  };
}

type LlvmCovJson = {
  data: Array<{
    files: Array<{
      filename: string;
      summary: {
        lines: { count: number; covered: number; percent: number };
        functions?: { count: number; covered: number; percent: number };
        regions?: { count: number; covered: number; percent: number };
      };
      segments?: Array<[number, number, number, boolean, boolean, boolean]>;
    }>;
    totals?: {
      lines: { count: number; covered: number; percent: number };
      functions?: { count: number; covered: number; percent: number };
      regions?: { count: number; covered: number; percent: number };
    };
  }>;
};

function parseLlvmCov(json: LlvmCovJson, cwd: string): CoverageReport {
  const block = json.data?.[0];
  if (!block) return { ecosystem: 'cargo', totals: {}, files: [] };
  const files: FileCoverage[] = (block.files ?? []).map(file => {
    const rel = isAbsolute(file.filename) ? relative(cwd, file.filename) : file.filename;
    const uncovered = new Set<number>();
    if (file.segments) {
      for (const [line, count, , hasCount, isRegionEntry] of file.segments) {
        if (hasCount && isRegionEntry && count === 0) uncovered.add(line);
      }
    }
    return {
      path: rel,
      lines: { covered: file.summary.lines.covered, total: file.summary.lines.count, pct: file.summary.lines.percent },
      functions: file.summary.functions && { covered: file.summary.functions.covered, total: file.summary.functions.count, pct: file.summary.functions.percent },
      branches: file.summary.regions && { covered: file.summary.regions.covered, total: file.summary.regions.count, pct: file.summary.regions.percent },
      uncoveredLines: Array.from(uncovered).sort((a, b) => a - b)
    };
  });
  const totals = block.totals ?? block.files?.[0]?.summary ?? null;
  return {
    ecosystem: 'cargo',
    totals: {
      lines: totals?.lines && { covered: totals.lines.covered, total: totals.lines.count, pct: totals.lines.percent },
      functions: totals?.functions && { covered: totals.functions.covered, total: totals.functions.count, pct: totals.functions.percent },
      branches: totals?.regions && { covered: totals.regions.covered, total: totals.regions.count, pct: totals.regions.percent }
    },
    files
  };
}

async function loadReport(detection: Detection, cwd: string): Promise<CoverageReport> {
  const reportAbs = join(cwd, detection.reportPath);
  if (!(await exists(reportAbs))) throw new Error(`coverage report not found at ${detection.reportPath}`);
  const raw = await readFile(reportAbs, 'utf8');

  if (detection.parser === 'istanbul-summary') {
    const json = JSON.parse(raw) as IstanbulSummary;
    const report = parseIstanbulSummary(json, cwd);
    report.ecosystem = detection.ecosystem;
    const finalPath = join(cwd, 'coverage', 'coverage-final.json');
    if (await exists(finalPath)) {
      try {
        const finalJson = JSON.parse(await readFile(finalPath, 'utf8')) as IstanbulFinal;
        for (const file of report.files) file.uncoveredLines = uncoveredLinesFromIstanbulFinal(finalJson, file.path, cwd);
      } catch {
        // ignore
      }
    }
    return report;
  }
  if (detection.parser === 'pytest-coverage') return parsePytestCoverage(JSON.parse(raw) as PytestCoverage);
  if (detection.parser === 'go-cover') return parseGoCover(raw, cwd);
  if (detection.parser === 'cargo-llvm-cov') return parseLlvmCov(JSON.parse(raw) as LlvmCovJson, cwd);
  throw new Error(`unsupported parser: ${detection.parser}`);
}

type DiffHunk = { path: string; lines: number[] };

function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentPath: string | null = null;
  let currentLines: number[] = [];
  let line = 0;

  const flush = () => {
    if (currentPath && currentLines.length > 0) hunks.push({ path: currentPath, lines: currentLines });
    currentLines = [];
  };

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      flush();
      const after = raw.slice(4).trim();
      currentPath = after.startsWith('b/') ? after.slice(2) : after === '/dev/null' ? null : after;
      currentLines = [];
      continue;
    }
    if (raw.startsWith('@@')) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(raw);
      if (!match) continue;
      line = Number(match[1]);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (currentPath) currentLines.push(line);
      line++;
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      // deletion does not advance new-file line counter
    } else if (raw.startsWith(' ')) {
      line++;
    }
  }
  flush();
  return hunks;
}

function pct(covered: number, total: number) {
  if (total === 0) return 100;
  return (covered / total) * 100;
}

function formatPct(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) return '   - ';
  return `${value.toFixed(1).padStart(5)}%`;
}

function renderReport(report: CoverageReport, opts: { topUncovered: number; ecosystem: CoverageEcosystem }) {
  const lines = [`coverage · ${opts.ecosystem}`];
  const t = report.totals;
  if (t.lines) lines.push(`  lines      ${formatPct(t.lines.pct)}  ${t.lines.covered}/${t.lines.total}`);
  if (t.statements) lines.push(`  statements ${formatPct(t.statements.pct)}  ${t.statements.covered}/${t.statements.total}`);
  if (t.branches) lines.push(`  branches   ${formatPct(t.branches.pct)}  ${t.branches.covered}/${t.branches.total}`);
  if (t.functions) lines.push(`  functions  ${formatPct(t.functions.pct)}  ${t.functions.covered}/${t.functions.total}`);

  const sorted = report.files
    .filter(f => (f.lines?.total ?? f.statements?.total ?? 0) > 0)
    .sort((a, b) => (a.lines?.pct ?? a.statements?.pct ?? 100) - (b.lines?.pct ?? b.statements?.pct ?? 100));

  if (sorted.length === 0) return lines.join('\n');

  lines.push('', `--- least covered (top ${Math.min(opts.topUncovered, sorted.length)}) ---`);
  for (const file of sorted.slice(0, opts.topUncovered)) {
    const metric = file.lines ?? file.statements;
    const uncoveredPreview = file.uncoveredLines.slice(0, 12).join(', ');
    const more = file.uncoveredLines.length > 12 ? ` +${file.uncoveredLines.length - 12} more` : '';
    lines.push(
      `  ${formatPct(metric?.pct)}  ${file.path}  (${metric?.covered ?? 0}/${metric?.total ?? 0})${file.uncoveredLines.length ? `\n      uncovered: ${uncoveredPreview}${more}` : ''}`
    );
  }
  return lines.join('\n');
}

function renderDiffCoverage(report: CoverageReport, hunks: DiffHunk[]) {
  const fileLookup = new Map(report.files.map(f => [f.path, f]));
  let totalChanged = 0;
  let totalCovered = 0;
  const perFile: { path: string; covered: number; total: number; uncovered: number[] }[] = [];

  for (const hunk of hunks) {
    const fileReport = fileLookup.get(hunk.path);
    if (!fileReport) continue;
    const uncoveredSet = new Set(fileReport.uncoveredLines);
    const total = hunk.lines.length;
    if (total === 0) continue;
    let covered = 0;
    const uncovered: number[] = [];
    for (const line of hunk.lines) {
      if (uncoveredSet.has(line)) uncovered.push(line);
      else covered++;
    }
    totalChanged += total;
    totalCovered += covered;
    perFile.push({ path: hunk.path, covered, total, uncovered });
  }

  const lines = ['', `--- changed-line coverage (vs git diff) ---`];
  if (perFile.length === 0) {
    lines.push('  no changed lines mapped to coverage data');
    return lines.join('\n');
  }
  lines.push(`  total: ${formatPct(pct(totalCovered, totalChanged))}  ${totalCovered}/${totalChanged} changed lines covered`);
  for (const file of perFile) {
    const preview = file.uncovered.slice(0, 12).join(', ');
    const more = file.uncovered.length > 12 ? ` +${file.uncovered.length - 12} more` : '';
    lines.push(
      `  ${formatPct(pct(file.covered, file.total))}  ${file.path}  (${file.covered}/${file.total})${file.uncovered.length ? `\n      uncovered: ${preview}${more}` : ''}`
    );
  }
  return lines.join('\n');
}

export function createCoverageTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      "Run test coverage and parse it. Auto-detects vitest/jest/pytest/go/cargo. Returns overall %, per-file %, and uncovered line numbers. With diff_coverage=true and a base ref, also reports what % of the lines you changed are covered — turning 'tests pass' into 'tests pass and the change is tested.'",
    inputSchema: z.object({
      action: z.enum(['run', 'parse', 'detect']).optional().describe("'run' (default) executes the command then parses; 'parse' just reads existing report; 'detect' shows what would be run."),
      cmd: z.string().optional().describe('Override auto-detected coverage command.'),
      report_path: z.string().optional().describe('Override path to coverage report file.'),
      ecosystem: z.enum(['vitest', 'jest', 'pytest', 'go', 'cargo']).optional().describe('Force a specific ecosystem.'),
      top: z.number().int().positive().max(50).optional().describe('How many least-covered files to list (default 15).'),
      diff_coverage: z.boolean().optional().describe('Compute coverage of lines changed vs base ref (default true when base provided).'),
      base: z.string().optional().describe('Git ref to diff against for changed-line coverage (default HEAD if diff_coverage true).')
    }),
    execute: async ({ action, cmd, report_path, ecosystem, top, diff_coverage, base }) => {
      const cwd = process.cwd();
      const detection = await detectCoverage(cwd);
      if (ecosystem && detection.ecosystem !== ecosystem) {
        const overrides: Record<string, Detection> = {
          vitest: { ecosystem: 'vitest', runCmd: 'npx vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=json --coverage.reportsDirectory=coverage', reportPath: 'coverage/coverage-summary.json', parser: 'istanbul-summary', notes: ['forced vitest'] },
          jest: { ecosystem: 'jest', runCmd: 'npx jest --coverage --coverageReporters=json-summary --coverageReporters=json --coverageDirectory=coverage', reportPath: 'coverage/coverage-summary.json', parser: 'istanbul-summary', notes: ['forced jest'] },
          pytest: { ecosystem: 'pytest', runCmd: 'pytest --cov=. --cov-report=json:coverage.json', reportPath: 'coverage.json', parser: 'pytest-coverage', notes: ['forced pytest'] },
          go: { ecosystem: 'go', runCmd: 'go test -coverprofile=coverage.out ./...', reportPath: 'coverage.out', parser: 'go-cover', notes: ['forced go'] },
          cargo: { ecosystem: 'cargo', runCmd: 'cargo llvm-cov --json --output-path coverage.json', reportPath: 'coverage.json', parser: 'cargo-llvm-cov', notes: ['forced cargo'] }
        };
        Object.assign(detection, overrides[ecosystem]);
      }
      if (cmd) detection.runCmd = cmd;
      if (report_path) detection.reportPath = report_path;

      if (detection.ecosystem === 'unknown' && !cmd) {
        return ['unable to detect coverage tooling', 'pass `cmd` and `report_path` to run a custom coverage command.'].join('\n');
      }

      const act = action ?? 'run';
      if (act === 'detect') {
        return [
          `ecosystem: ${detection.ecosystem}`,
          `cmd:       ${detection.runCmd || '(none)'}`,
          `report:    ${detection.reportPath || '(none)'}`,
          `parser:    ${detection.parser}`,
          `notes:     ${detection.notes.join('; ')}`
        ].join('\n');
      }

      if (act === 'run') {
        if (!detection.runCmd) return 'no coverage command configured';
        if (!(await requestApproval({ scope: 'command', title: 'Run coverage', detail: detection.runCmd }))) {
          throw new Error('command denied by user');
        }
        const result = await runUserShell(detection.runCmd);
        if (result.exitCode !== 0 && !(await exists(join(cwd, detection.reportPath)))) {
          return `coverage command exited ${result.exitCode} and no report was produced.\n\n${truncate(plain(result.output).trim(), 4000)}`;
        }
      }

      const report = await loadReport(detection, cwd);
      report.ecosystem = detection.ecosystem;
      const lines = [renderReport(report, { topUncovered: top ?? 15, ecosystem: detection.ecosystem })];

      const wantDiffCoverage = diff_coverage ?? !!base;
      if (wantDiffCoverage) {
        const baseRef = base ?? 'HEAD';
        const diffResult = await runUserShell(`git diff --no-color --unified=0 ${baseRef}`);
        if (diffResult.exitCode === 0) {
          const hunks = parseDiffHunks(plain(diffResult.output));
          if (hunks.length > 0) lines.push(renderDiffCoverage(report, hunks));
          else lines.push('', '(no changed lines vs base ref)');
        } else {
          lines.push('', `(could not get diff vs ${baseRef}: exit ${diffResult.exitCode})`);
        }
      }

      return lines.join('\n');
    }
  });
}
