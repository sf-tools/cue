import { readFile, writeFile } from 'node:fs/promises';

import { tool } from 'ai';
import { z } from 'zod';

import { applyEdits, createFileChange, describeFileChange, type EditSpec } from '@/file-changes';
import { plain } from '@/text';
import type { UndoEntry } from '@/undo';
import type { ToolFactoryOptions } from './types';

function previewSnippet(text: string, maxChars = 160) {
  const normalized = plain(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

function previewEdits(edits: EditSpec[], maxItems = 3) {
  const items = edits
    .slice(0, maxItems)
    .flatMap((edit, index) => [
      `${index + 1}. - ${previewSnippet(edit.oldText)}`,
      `   + ${previewSnippet(edit.newText)}`,
    ]);

  if (edits.length > maxItems)
    items.push(
      `… ${edits.length - maxItems} more change${edits.length - maxItems === 1 ? '' : 's'}`,
    );
  return items;
}

export function createEditTool({ requestApproval, pushUndoEntry }: ToolFactoryOptions) {
  return tool({
    description: 'Edit an existing file by applying exact text replacements',
    inputSchema: z.object({
      path: z.string(),
      edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1),
    }),
    execute: async ({ path, edits }) => {
      const previousContent = await readFile(path, 'utf8');
      const nextContent = applyEdits(previousContent, edits as EditSpec[]);
      const fileChange = createFileChange(path, previousContent, nextContent);

      if (
        !(await requestApproval({
          scope: 'edit',
          title: 'Edit file',
          detail: `${path} · ${describeFileChange(fileChange)}`,
          body: fileChange.hasChanges ? undefined : previewEdits(edits),
          fileChanges: [fileChange],
        }))
      ) {
        throw new Error('edit denied by user');
      }

      await writeFile(path, nextContent);
      const undoEntry: UndoEntry = {
        toolName: 'edit',
        summary: `edit ${path}`,
        files: [{ path, previousContent, nextContent }],
      };
      pushUndoEntry(undoEntry);
      return `applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${path}`;
    },
  });
}
