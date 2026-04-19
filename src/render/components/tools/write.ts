import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import {
  formatBytes,
  inferCodeLanguage,
  previewCodeBlock,
  renderFileChanges,
  renderToolCard,
  stringProp,
} from './shared';

export function renderWriteTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const path = stringProp(entry.input, 'path') || 'file';
  const content = stringProp(entry.input, 'content') || '';
  const size = content ? formatBytes(Buffer.byteLength(content)) : '';
  const detail = size ? `${path} · ${size}` : path;
  const body =
    entry.status === 'failed'
      ? [entry.errorText || 'write failed']
      : !entry.fileChanges?.length && content
        ? []
        : [typeof entry.output === 'string' ? entry.output : `path: ${path}`];
  const bodyBlock = [
    ...(!entry.fileChanges?.length && content
      ? previewCodeBlock(content, inferCodeLanguage(path), ctx, 8)
      : []),
    ...(entry.fileChanges?.length ? renderFileChanges(entry.fileChanges, ctx) : []),
  ];

  return renderToolCard({ name: 'write', detail, body, bodyBlock, status: entry.status }, ctx);
}
