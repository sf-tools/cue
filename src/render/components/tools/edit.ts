import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { arrayProp, renderToolCard, stringProp } from './shared';

export function renderEditTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const path = stringProp(entry.input, 'path') || stringProp(entry.input, 'filePath') || 'file';
  const edits = arrayProp(entry.input, 'edits');
  const detail = edits?.length ? `${path} · ${edits.length} change${edits.length === 1 ? '' : 's'}` : path;
  const body = entry.status === 'failed'
    ? [entry.errorText || 'edit failed']
    : edits?.length
      ? edits.slice(0, 3).map((_, index) => `edit ${index + 1}`)
      : [`path: ${path}`];

  return renderToolCard({ name: 'edit', detail, body, status: entry.status }, ctx);
}
