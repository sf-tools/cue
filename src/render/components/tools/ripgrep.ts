import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { asRecord, numberProp, previewText, renderToolCard, stringProp } from './shared';

export function renderRipgrepTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const pattern = stringProp(entry.input, 'pattern') || entry.title || 'search';
  const path = stringProp(entry.input, 'path') || '.';
  const output = asRecord(entry.output);
  const engine = output && typeof output.engine === 'string' ? output.engine : null;
  const matches = numberProp(entry.output, 'matches');
  const text = stringProp(entry.output, 'output') || '';
  const detail =
    matches === null ? pattern : `${pattern} · ${matches} match${matches === 1 ? '' : 'es'}`;
  const body =
    entry.status === 'failed'
      ? [entry.errorText || 'search failed']
      : [
          `pattern: ${pattern}`,
          `path: ${path}`,
          `engine: ${engine === 'grep' ? 'grep fallback' : engine || 'rg'}`,
          ...(matches === null ? [] : [`matches: ${matches}`]),
          ...(text.trim() ? previewText(text, ctx, 8) : ['no matches']),
        ];

  return renderToolCard({ name: 'ripgrep', detail, body, status: entry.status }, ctx);
}
