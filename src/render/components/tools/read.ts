import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import {
  asRecord,
  formatBytes,
  inferCodeLanguage,
  previewCodeBlock,
  renderToolCard,
  stringProp,
} from './shared';

type ImageOutput = {
  kind: 'image';
  path: string;
  mediaType: string;
  bytes: number;
};

function asImageOutput(value: unknown): ImageOutput | null {
  const record = asRecord(value);
  if (!record || record.kind !== 'image') return null;
  if (
    typeof record.path !== 'string' ||
    typeof record.mediaType !== 'string' ||
    typeof record.bytes !== 'number'
  )
    return null;
  return {
    kind: 'image',
    path: record.path,
    mediaType: record.mediaType,
    bytes: record.bytes,
  };
}

export function renderReadTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const path = stringProp(entry.input, 'path') || 'file';
  const image = asImageOutput(entry.output);

  if (image) {
    const detail = `${image.path} · image · ${formatBytes(image.bytes)}`;
    const body =
      entry.status === 'failed'
        ? [entry.errorText || 'read failed']
        : [`attached as ${image.mediaType} for visual inspection`];
    return renderToolCard({ name: 'read', detail, body, status: entry.status }, ctx);
  }

  const output = typeof entry.output === 'string' ? entry.output : '';
  const stats = output
    ? `${output.split('\n').length} lines · ${formatBytes(Buffer.byteLength(output))}`
    : '';
  const detail = stats ? `${path} · ${stats}` : path;
  const body =
    entry.status === 'failed'
      ? [entry.errorText || 'read failed']
      : output
        ? []
        : [`path: ${path}`];
  const bodyBlock =
    entry.status !== 'failed' && output
      ? previewCodeBlock(output, inferCodeLanguage(path), ctx, 8)
      : [];

  return renderToolCard({ name: 'read', detail, body, bodyBlock, status: entry.status }, ctx);
}
