import { readFile, writeFile } from 'node:fs/promises';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';

type EditSpec = {
  oldText: string;
  newText: string;
};

type Match = {
  index: number;
  oldText: string;
  newText: string;
};

function findUniqueMatch(content: string, needle: string) {
  let firstIndex = -1;
  let count = 0;
  let searchFrom = 0;

  while (true) {
    const index = content.indexOf(needle, searchFrom);
    if (index === -1) break;
    if (count === 0) firstIndex = index;
    count += 1;
    searchFrom = index + Math.max(1, needle.length);
  }

  if (count === 0) throw new Error('oldText not found');
  if (count > 1) throw new Error('oldText must match exactly once');
  return firstIndex;
}

function ensureNonOverlapping(matches: Match[]) {
  const sorted = matches.slice().sort((a, b) => a.index - b.index);

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.index < previous.index + previous.oldText.length) {
      throw new Error('edits overlap');
    }
  }

  return sorted;
}

function applyEdits(content: string, edits: EditSpec[]) {
  const matches = ensureNonOverlapping(
    edits.map(edit => ({
      index: findUniqueMatch(content, edit.oldText),
      oldText: edit.oldText,
      newText: edit.newText
    }))
  );

  let output = content;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    output = `${output.slice(0, match.index)}${match.newText}${output.slice(match.index + match.oldText.length)}`;
  }

  return output;
}

function previewSnippet(text: string, maxChars = 160) {
  const normalized = plain(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

function previewEdits(edits: EditSpec[], maxItems = 3) {
  const items = edits
    .slice(0, maxItems)
    .flatMap((edit, index) => [`${index + 1}. - ${previewSnippet(edit.oldText)}`, `   + ${previewSnippet(edit.newText)}`]);

  if (edits.length > maxItems) items.push(`… ${edits.length - maxItems} more change${edits.length - maxItems === 1 ? '' : 's'}`);
  return items;
}

export function createEditTool({ requestApproval }: ToolFactoryOptions) {
  return tool({
    description: 'Edit an existing file by applying exact text replacements',
    inputSchema: z.object({
      path: z.string(),
      edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1)
    }),
    execute: async ({ path, edits }) => {
      if (
        !(await requestApproval({
          scope: 'edit',
          title: 'Edit file',
          detail: `${path} · ${edits.length} change${edits.length === 1 ? '' : 's'}`,
          body: previewEdits(edits)
        }))
      ) {
        throw new Error('edit denied by user');
      }

      const content = await readFile(path, 'utf8');
      const next = applyEdits(content, edits);
      await writeFile(path, next);
      return `applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${path}`;
    }
  });
}
