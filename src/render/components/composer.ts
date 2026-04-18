import chalk from 'chalk';

import { repeat, widthOf } from '@/text';
import { panelize } from '../layout';
import { line, span } from '../primitives';

import type { ComposerRenderResult, RenderContext } from '../types';

type ComposerState = {
  inputChars: string[];
  cursor: number;
  scrollOffset: number;
};

function charWidth(ch: string) {
  return Math.max(1, widthOf(ch));
}

function normalizeScroll({ inputChars, cursor, scrollOffset }: ComposerState, viewWidth: number) {
  let nextScrollOffset = Math.max(0, scrollOffset);

  if (cursor < nextScrollOffset) nextScrollOffset = cursor;

  let used = 0;
  for (let index = cursor - 1; index >= nextScrollOffset; index -= 1) used += charWidth(inputChars[index]);

  while (used > viewWidth && nextScrollOffset < cursor) {
    used -= charWidth(inputChars[nextScrollOffset]);
    nextScrollOffset += 1;
  }

  return nextScrollOffset;
}

function renderInputContent(state: ComposerState, viewWidth: number) {
  const nextScrollOffset = normalizeScroll(state, viewWidth);

  let used = 0;
  let end = nextScrollOffset;

  while (end < state.inputChars.length) {
    const width = charWidth(state.inputChars[end]);
    if (used + width > viewWidth) break;
    used += width;
    end += 1;
  }

  const visibleChars = state.inputChars.slice(nextScrollOffset, end);
  const cursorIndex = Math.max(0, Math.min(visibleChars.length, state.cursor - nextScrollOffset));
  const activeChar = visibleChars[cursorIndex] ?? ' ';
  const before = visibleChars.slice(0, cursorIndex).join('');
  const after = visibleChars.slice(cursorIndex + (cursorIndex < visibleChars.length ? 1 : 0)).join('');
  const visibleWidth = widthOf(visibleChars.join('')) + (cursorIndex >= visibleChars.length ? 1 : 0);

  return {
    nextScrollOffset,
    segments: [span(before), span(activeChar, chalk.inverse), span(after)],
    fill: repeat(' ', Math.max(0, viewWidth - visibleWidth))
  };
}

export function renderComposer(state: ComposerState, ctx: RenderContext): ComposerRenderResult {
  const contentWidth = Math.max(1, ctx.width - 4);
  const prompt = state.inputChars.length === 0 ? span('→', ctx.theme.dimmed) : span('→', ctx.theme.foreground);

  if (state.inputChars.length === 0) {
    const label = 'Plan, search, build anything';
    const fill = repeat(' ', Math.max(0, contentWidth - 1 - widthOf(label)));

    return {
      nextScrollOffset: state.scrollOffset,
      block: panelize([line(prompt, span(' '), span('P', chalk.inverse), span(label.slice(1), ctx.theme.dimmed), span(fill))], {
        bg: ctx.theme.composerBg(),
        width: ctx.width
      })
    };
  }

  const { nextScrollOffset, segments, fill } = renderInputContent(state, contentWidth);

  return {
    nextScrollOffset,
    block: panelize([line(prompt, span(' '), ...segments, span(fill))], { bg: ctx.theme.composerBg(), width: ctx.width })
  };
}
