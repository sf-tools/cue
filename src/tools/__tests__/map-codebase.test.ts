import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCodebaseMap } from '../map-codebase';
import type { ShellResult } from '@/types';

async function setupRepo() {
  const root = await mkdtemp(join(tmpdir(), 'cue-map-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'src/server'), { recursive: true });
  await mkdir(join(root, 'src/client'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.github/workflows'), { recursive: true });

  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'sample',
    main: 'src/index.ts',
    bin: { sample: 'src/cli.ts' },
    scripts: { start: 'node src/index.js', dev: 'tsx watch src/index.ts' },
  }));
  await writeFile(join(root, 'tsconfig.json'), '{}');
  await writeFile(join(root, 'README.md'), '# Sample');
  await writeFile(join(root, 'src/index.ts'), 'export const x = 1;\n');
  await writeFile(join(root, 'src/cli.ts'), '#!/usr/bin/env node\n');
  await writeFile(join(root, 'src/server/app.ts'), 'export const app = {};\n');
  await writeFile(join(root, 'src/server/db.ts'), 'export const db = {};\n');
  await writeFile(join(root, 'src/client/page.tsx'), 'export default () => null;\n');
  await writeFile(join(root, 'tests/app.test.ts'), 'test("noop", () => {});\n');
  await writeFile(join(root, 'docs/architecture.md'), '# Arch');
  await writeFile(join(root, '.github/workflows/ci.yml'), 'name: ci');
  return root;
}

const noShell = async (): Promise<ShellResult> => ({ exitCode: 1, output: '__NO_RG__' });

describe('buildCodebaseMap', () => {
  test('summarizes a small repo correctly', async () => {
    const root = await setupRepo();
    const result = await buildCodebaseMap(root, noShell);
    expect(result.total_files).toBeGreaterThan(5);
    expect(result.ecosystems).toContain('node');
    expect(result.subsystems.some(s => s.path.startsWith('src'))).toBe(true);
    expect(result.entrypoints.some(e => e.kind === 'main')).toBe(true);
    expect(result.entrypoints.some(e => e.kind === 'bin')).toBe(true);
    expect(result.docs.some(doc => /readme\.md$/i.test(doc))).toBe(true);
    expect(result.configs.some(cfg => cfg.kind === 'typescript')).toBe(true);
    expect(result.configs.some(cfg => cfg.kind === 'package')).toBe(true);
    expect(result.configs.some(cfg => cfg.kind === 'ci')).toBe(true);
    expect(result.language_breakdown.some(item => item.language === 'typescript')).toBe(true);
    expect(result.summary).toContain('files');
  });

  test('classifies tests/docs subsystems by role', async () => {
    const root = await setupRepo();
    const result = await buildCodebaseMap(root, noShell);
    const tests = result.subsystems.find(s => s.path === 'tests');
    expect(tests?.role).toBe('tests');
    const docs = result.subsystems.find(s => s.path === 'docs');
    expect(docs?.role).toBe('docs');
  });
});
