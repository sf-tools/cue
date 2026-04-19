import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { previewJson, renderToolCard } from './shared';

export function renderGenericTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const body = entry.status === 'failed'
    ? [entry.errorText || 'tool failed', 'input:', ...previewJson(entry.input)]
    : entry.status === 'running'
      ? ['input:', ...previewJson(entry.input)]
      : ['input:', ...previewJson(entry.input), 'output:', ...previewJson(entry.output)];

  return renderToolCard({ name: entry.toolName.replace(/_/g, ' '), body, status: entry.status }, ctx);
}
