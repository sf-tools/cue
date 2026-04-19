import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { createFileChange, describeFileChange, normalizeLineEndings } from '@/file-changes';
import type { FileChange } from '@/types';
import type { UndoEntry } from '@/undo';
import type { ToolFactoryOptions } from './types';

type HunkLine = { kind: 'context' | 'add' | 'remove'; text: string };

type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
};

type PatchFile = {
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
};

type PendingFile = {
  path: string;
  previousContent: string | null;
  nextContent: string | null;
  fileChange: FileChange;
};

const FUZZ = 20;

function parsePatch(patch: string): PatchFile[] {
  const lines = normalizeLineEndings(patch).split('\n');
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let i = 0;

  const stripPrefix = (raw: string): string | null => {
    const value = raw.trim();
    if (!value || value === '/dev/null') return null;
    if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2);
    return value;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('--- ')) {
      const oldPath = stripPrefix(line.slice(4));
      const next = lines[i + 1];
      if (!next?.startsWith('+++ ')) throw new Error(`malformed patch: expected '+++' after '---' at line ${i + 1}`);
      const newPath = stripPrefix(next.slice(4));
      current = { oldPath, newPath, hunks: [] };
      files.push(current);
      i += 2;
      continue;
    }

    if (line.startsWith('@@')) {
      if (!current) throw new Error(`malformed patch: hunk before file header at line ${i + 1}`);
      const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!header) throw new Error(`malformed hunk header at line ${i + 1}: ${line}`);

      const hunk: Hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] ? Number(header[2]) : 1,
        newStart: Number(header[3]),
        newCount: header[4] ? Number(header[4]) : 1,
        lines: []
      };

      i += 1;
      let consumedOld = 0;
      let consumedNew = 0;
      while (i < lines.length && (consumedOld < hunk.oldCount || consumedNew < hunk.newCount)) {
        const next = lines[i];
        if (next.startsWith('@@') || next.startsWith('--- ') || next.startsWith('diff ')) break;

        if (next.startsWith('\\')) {
          i += 1;
          continue;
        }

        if (next.startsWith(' ')) {
          hunk.lines.push({ kind: 'context', text: next.slice(1) });
          consumedOld += 1;
          consumedNew += 1;
        } else if (next.startsWith('+')) {
          hunk.lines.push({ kind: 'add', text: next.slice(1) });
          consumedNew += 1;
        } else if (next.startsWith('-')) {
          hunk.lines.push({ kind: 'remove', text: next.slice(1) });
          consumedOld += 1;
        } else if (next === '') {
          break;
        } else {
          break;
        }

        i += 1;
      }

      current.hunks.push(hunk);
      continue;
    }

    i += 1;
  }

  if (files.length === 0) throw new Error('no file headers found in patch');
  return files;
}

function tryApplyAt(source: string[], hunk: Hunk, position: number): string[] | null {
  const consumed: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === 'add') continue;
    consumed.push(line.text);
  }

  if (position < 0 || position + consumed.length > source.length) return null;
  for (let k = 0; k < consumed.length; k += 1) {
    if (source[position + k] !== consumed[k]) return null;
  }

  const produced: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === 'remove') continue;
    produced.push(line.text);
  }

  return [...source.slice(0, position), ...produced, ...source.slice(position + consumed.length)];
}

function locateAndApply(source: string[], hunk: Hunk): string[] {
  const baseIndex = Math.max(0, hunk.oldStart - 1);

  const direct = tryApplyAt(source, hunk, baseIndex);
  if (direct) return direct;

  for (let delta = 1; delta <= FUZZ; delta += 1) {
    const before = tryApplyAt(source, hunk, baseIndex - delta);
    if (before) return before;
    const after = tryApplyAt(source, hunk, baseIndex + delta);
    if (after) return after;
  }

  throw new Error(`hunk @ -${hunk.oldStart},${hunk.oldCount} could not be located (context mismatch)`);
}

function splitForPatch(content: string | null): string[] {
  if (content === null) return [];
  const normalized = normalizeLineEndings(content);
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function joinForPatch(lines: string[], originalHadTrailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return originalHadTrailingNewline ? `${lines.join('\n')}\n` : lines.join('\n');
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function buildPending(file: PatchFile): Promise<PendingFile> {
  const isCreate = file.oldPath === null && file.newPath !== null;
  const isDelete = file.newPath === null && file.oldPath !== null;
  const targetPath = file.newPath ?? file.oldPath;
  if (!targetPath) throw new Error('patch entry missing both old and new paths');

  const previousContent = isCreate ? null : await readMaybe(targetPath);
  if (!isCreate && previousContent === null) throw new Error(`cannot patch missing file: ${targetPath}`);

  const trailingNewline = previousContent !== null && previousContent.endsWith('\n');
  let working = splitForPatch(previousContent);

  for (const hunk of file.hunks) {
    working = locateAndApply(working, hunk);
  }

  const nextContent = isDelete ? null : joinForPatch(working, trailingNewline || previousContent === null);
  const fileChange = createFileChange(targetPath, previousContent, nextContent);

  return { path: targetPath, previousContent, nextContent, fileChange };
}

function summarize(pending: PendingFile[]) {
  const parts = pending.map(item => `${item.path} · ${describeFileChange(item.fileChange)}`);
  return parts.join('\n');
}

export function createApplyPatchTool({ requestApproval, pushUndoEntry }: ToolFactoryOptions) {
  return tool({
    description:
      'Apply a multi-file unified diff atomically. Patch must contain `--- a/path` and `+++ b/path` headers per file, plus `@@ -old,n +new,n @@` hunks. Use `/dev/null` for create or delete. Best for batched edits across many files; for a single small change prefer `edit`.',
    inputSchema: z.object({
      patch: z.string().min(1).describe('Unified diff text with file headers and hunks.')
    }),
    execute: async ({ patch }) => {
      const files = parsePatch(patch);
      const pending: PendingFile[] = [];
      for (const file of files) pending.push(await buildPending(file));

      const fileChanges = pending.map(item => item.fileChange);
      const detail = `${pending.length} file${pending.length === 1 ? '' : 's'}`;

      if (
        !(await requestApproval({
          scope: 'edit',
          title: 'Apply patch',
          detail,
          body: summarize(pending).split('\n'),
          fileChanges
        }))
      ) {
        throw new Error('patch denied by user');
      }

      const undoFiles: UndoEntry['files'] = [];
      for (const item of pending) {
        if (item.nextContent === null) {
          await rm(item.path, { force: true });
        } else {
          await mkdir(dirname(item.path), { recursive: true });
          await writeFile(item.path, item.nextContent);
        }
        undoFiles.push({ path: item.path, previousContent: item.previousContent, nextContent: item.nextContent });
      }

      pushUndoEntry({
        toolName: 'apply_patch',
        summary: `apply_patch ${pending.length} file${pending.length === 1 ? '' : 's'}`,
        files: undoFiles
      });

      return `applied patch to ${pending.length} file${pending.length === 1 ? '' : 's'}:\n${summarize(pending)}`;
    }
  });
}
