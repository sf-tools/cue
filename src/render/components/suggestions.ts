import { LEFT_MARGIN } from '../layout';
import { line, span } from '../primitives';

import type { Block, RenderContext } from '../types';

export function renderSuggestions(suggestions: string[], selectedSuggestion: number, ctx: RenderContext): Block {
  if (suggestions.length === 0) return [];

  return suggestions.map((suggestion, index) =>
    index === selectedSuggestion
      ? line(span(LEFT_MARGIN), span('→', ctx.theme.foreground), span(' '), span(suggestion, ctx.theme.foreground))
      : line(span(`${LEFT_MARGIN}  `), span(suggestion, ctx.theme.dimmed))
  );
}
