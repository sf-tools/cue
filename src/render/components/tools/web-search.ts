import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { arrayProp, asRecord, renderToolCard, stringProp } from './shared';

export function renderWebSearchTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const output = asRecord(entry.output);
  const action = output ? asRecord(output.action) : null;
  const query = (action && typeof action.query === 'string' ? action.query : null) || entry.title || 'search';
  const sources = output ? arrayProp(output, 'sources') : null;
  const hosts = [...new Set((sources || []).flatMap(source => {
    const url = stringProp(source, 'url');
    if (!url) return [];

    try {
      return [new URL(url).hostname.replace(/^www\./, '')];
    } catch {
      return [url];
    }
  }))];

  const body = entry.status === 'failed'
    ? [entry.errorText || 'search failed']
    : hosts.length > 0
      ? [`query: ${query}`, `sources: ${hosts.slice(0, 6).join(', ')}${hosts.length > 6 ? ` +${hosts.length - 6} more` : ''}`]
      : [`query: ${query}`];

  return renderToolCard({ name: 'web search', detail: query, body, status: entry.status }, ctx);
}
