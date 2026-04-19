import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { formatBytes, previewText, renderToolCard, stringProp } from './shared';

export function renderWriteTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const path = stringProp(entry.input, 'path') || 'file';
  const content = stringProp(entry.input, 'content') || '';
  const size = content ? formatBytes(Buffer.byteLength(content)) : '';
  const detail = size ? `${path} · ${size}` : path;
  const body = entry.status === 'failed'
    ? [entry.errorText || 'write failed']
    : content
      ? previewText(content, 8)
      : [typeof entry.output === 'string' ? entry.output : `path: ${path}`];

  return renderToolCard({ name: 'write', detail, body, status: entry.status }, ctx);
}
