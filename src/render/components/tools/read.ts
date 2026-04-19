import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { formatBytes, previewText, renderToolCard, stringProp } from './shared';

export function renderReadTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const path = stringProp(entry.input, 'path') || 'file';
  const output = typeof entry.output === 'string' ? entry.output : '';
  const stats = output ? `${output.split('\n').length} lines · ${formatBytes(Buffer.byteLength(output))}` : '';
  const detail = stats ? `${path} · ${stats}` : path;
  const body = entry.status === 'failed'
    ? [entry.errorText || 'read failed']
    : output
      ? previewText(output, 8)
      : [`path: ${path}`];

  return renderToolCard({ name: 'read', detail, body, status: entry.status }, ctx);
}
