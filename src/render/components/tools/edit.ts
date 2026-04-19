import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { arrayProp, asRecord, renderFileChanges, renderToolCard, stringProp } from './shared';

function previewSnippet(text: string, maxChars = 120) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

export function renderEditTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const path = stringProp(entry.input, 'path') || stringProp(entry.input, 'filePath') || 'file';
  const edits = arrayProp(entry.input, 'edits');
  const detail = edits?.length ? `${path} · ${edits.length} change${edits.length === 1 ? '' : 's'}` : path;
  const body =
    entry.status === 'failed'
      ? [entry.errorText || 'edit failed']
      : !entry.fileChanges?.length && edits?.length
        ? edits.slice(0, 3).flatMap((value, index) => {
            const edit = asRecord(value);
            const oldText = edit && typeof edit.oldText === 'string' ? edit.oldText : '';
            const newText = edit && typeof edit.newText === 'string' ? edit.newText : '';
            return [`${index + 1}. - ${previewSnippet(oldText)}`, `   + ${previewSnippet(newText)}`];
          })
        : [`path: ${path}`];
  const bodyBlock = entry.fileChanges?.length ? renderFileChanges(entry.fileChanges, ctx) : [];

  return renderToolCard({ name: 'edit', detail, body, bodyBlock, status: entry.status }, ctx);
}
