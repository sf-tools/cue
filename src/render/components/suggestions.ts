import { LEFT_MARGIN } from '../layout';
import { line, span } from '../primitives';
import { repeat, widthOf } from '@/text';

import type { Block, RenderContext } from '../types';
import type { ComposerSuggestion } from '@/agent/composer-suggestions';

export function renderSuggestions(suggestions: ComposerSuggestion[], selectedSuggestion: number, ctx: RenderContext): Block {
  if (suggestions.length === 0) return [];
  const margin = LEFT_MARGIN.repeat(2);
  const maxLabelWidth = suggestions.reduce(
    (max, suggestion) => Math.max(max, widthOf(suggestion.label) + widthOf('suffix' in suggestion ? (suggestion.suffix ?? '') : '')),
    0
  );

  return suggestions.map((suggestion, index) => {
    const selected = index === selectedSuggestion;
    const prefix = selected ? [span(margin), span('→', ctx.theme.foreground), span(' ')] : [span(`${margin}  `)];
    const lineStyle = selected ? ctx.theme.foreground : ctx.theme.dimmed;
    const suffixStyle = selected ? ctx.theme.dimmed : ctx.theme.subtle;
    const detailStyle = selected ? ctx.theme.foreground : ctx.theme.subtle;
    const detail = 'detail' in suggestion ? suggestion.detail : '';
    const suffix = 'suffix' in suggestion ? (suggestion.suffix ?? '') : '';
    const renderedWidth = widthOf(suggestion.label) + widthOf(suffix);
    const padding = detail ? repeat(' ', maxLabelWidth - renderedWidth + 3) : '';

    return line(
      ...prefix,
      span(suggestion.label, lineStyle),
      ...(suffix ? [span(suffix, suffixStyle)] : []),
      ...(detail ? [span(padding), span(detail, detailStyle)] : [])
    );
  });
}
