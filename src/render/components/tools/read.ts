import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { formatBytes, inferCodeLanguage, previewCodeBlock, renderToolCard, stringProp } from './shared';

export function renderReadTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const path = stringProp(entry.input, 'path') || 'file';
  const output = typeof entry.output === 'string' ? entry.output : '';
  const stats = output ? `${output.split('\n').length} lines · ${formatBytes(Buffer.byteLength(output))}` : '';
  const detail = stats ? `${path} · ${stats}` : path;
  const body = entry.status === 'failed' ? [entry.errorText || 'read failed'] : output ? [] : [`path: ${path}`];
  const bodyBlock = entry.status !== 'failed' && output ? previewCodeBlock(output, inferCodeLanguage(path), ctx, 8) : [];

  return renderToolCard({ name: 'read', detail, body, bodyBlock, status: entry.status }, ctx);
}
