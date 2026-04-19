import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { renderFileChanges, renderToolCard } from './shared';

export function renderUndoTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const detail = entry.fileChanges?.length ? `${entry.fileChanges.length} file${entry.fileChanges.length === 1 ? '' : 's'}` : undefined;
  const body = entry.status === 'failed'
    ? [entry.errorText || 'undo failed']
    : typeof entry.output === 'string'
      ? [entry.output]
      : ['undo'];
  const bodyBlock = entry.fileChanges?.length ? renderFileChanges(entry.fileChanges, ctx) : [];

  return renderToolCard({ name: 'undo', detail, body, bodyBlock, status: entry.status }, ctx);
}
