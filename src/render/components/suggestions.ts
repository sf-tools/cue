import { LEFT_MARGIN } from '../layout';
import { line, span } from '../primitives';

import type { Block, RenderContext } from '../types';
import type { ComposerSuggestion } from '@/agent/composer-suggestions';

export function renderSuggestions(suggestions: ComposerSuggestion[], selectedSuggestion: number, ctx: RenderContext): Block {
  if (suggestions.length === 0) return [];
  const margin = LEFT_MARGIN.repeat(2);

  return suggestions.map((suggestion, index) => {
    const prefix = index === selectedSuggestion ? [span(margin), span('→', ctx.theme.foreground), span(' ')] : [span(`${margin}  `)];
    const labelStyle = index === selectedSuggestion ? ctx.theme.foreground : ctx.theme.dimmed;
    const detailStyle = index === selectedSuggestion ? ctx.theme.dimmed : ctx.theme.subtle;
    const detail = 'detail' in suggestion ? suggestion.detail : '';

    return line(...prefix, span(suggestion.label, labelStyle), ...(detail ? [span(' — ', ctx.theme.subtle), span(detail, detailStyle)] : []));
  });
}
