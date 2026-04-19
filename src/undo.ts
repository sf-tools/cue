import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createFileChange } from '@/file-changes';
import type { FileChange } from '@/types';

export type UndoFileOperation = {
  path: string;
  previousContent: string | null;
  nextContent: string | null;
};

export type UndoEntry = {
  toolName: string;
  summary: string;
  files: UndoFileOperation[];
};

function isMissingFileError(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

export async function readOptionalFile(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export async function buildUndoFileChanges(entry: UndoEntry): Promise<FileChange[]> {
  const fileChanges: FileChange[] = [];

  for (const file of entry.files) {
    const currentContent = await readOptionalFile(file.path);
    fileChanges.push(createFileChange(file.path, currentContent, file.previousContent));
  }

  return fileChanges;
}

export async function applyUndoEntry(entry: UndoEntry) {
  for (const file of [...entry.files].reverse()) {
    if (file.previousContent === null) {
      await rm(file.path, { force: true });
      continue;
    }

    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.previousContent);
  }
}
