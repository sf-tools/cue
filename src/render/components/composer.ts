import chalk from 'chalk';

import { repeat, widthOf } from '@/text';
import { thinPanelize } from '../layout';
import { line, span } from '../primitives';

import type { ComposerRenderResult, RenderContext, StyledLine } from '../types';

type ComposerState = {
  inputChars: string[];
  cursor: number;
  scrollOffset: number;
  slashCommandLength?: number;
};

function charWidth(ch: string) {
  return Math.max(1, widthOf(ch));
}

function renderInputLines(state: ComposerState, viewWidth: number, charStyleAt?: (index: number, ch: string) => ((text: string) => string) | undefined) {
  const lines: StyledLine[] = [];
  let segments: StyledLine['segments'] = [];
  let currentWidth = 0;

  const flushLine = (allowEmpty = false) => {
    if (segments.length === 0 && !allowEmpty) return;
    lines.push(line(...segments));
    segments = [];
    currentWidth = 0;
  };

  const pushChar = (text: string, style?: (text: string) => string) => {
    const width = charWidth(text);

    if (segments.length > 0 && currentWidth + width > viewWidth) flushLine();

    segments.push(span(text, style));
    currentWidth += width;
  };

  for (let index = 0; index < state.inputChars.length; index += 1) {
    const ch = state.inputChars[index];

    if (index === state.cursor && ch === '\n') {
      pushChar(' ', chalk.inverse);
      flushLine(true);
      continue;
    }

    if (ch === '\n') {
      flushLine(true);
      continue;
    }

    pushChar(ch, index === state.cursor ? chalk.inverse : charStyleAt?.(index, ch));
  }

  if (state.cursor >= state.inputChars.length) pushChar(' ', chalk.inverse);
  if (segments.length === 0) segments.push(span(' ', chalk.inverse));

  flushLine();
  return lines;
}

export function renderComposer(state: ComposerState, ctx: RenderContext): ComposerRenderResult {
  const contentWidth = Math.max(1, ctx.width - 4);
  const shellMode = state.inputChars[0] === '!';
  const slashMode = state.inputChars[0] === '/';
  const validSlashCommand = slashMode && (state.slashCommandLength ?? 0) > 0;
  const prompt = state.inputChars.length === 0
    ? span('→', ctx.theme.dimmed)
    : shellMode
      ? span('!', chalk.yellow)
      : slashMode
        ? span('/', validSlashCommand ? chalk.cyanBright : ctx.theme.foreground)
        : span('→', ctx.theme.foreground);

  if (state.inputChars.length === 0) {
    const label = 'Plan, search, build anything';
    const fill = repeat(' ', Math.max(0, contentWidth - 1 - widthOf(label)));

    return {
      nextScrollOffset: state.scrollOffset,
      block: thinPanelize([line(prompt, span(' '), span('P', chalk.inverse), span(label.slice(1), ctx.theme.dimmed), span(fill))], {
        bg: ctx.theme.composerBg(),
        width: ctx.width
      })
    };
  }

  if (shellMode && state.inputChars.length === 1) {
    const label = 'Run a command — e.g., npm install';
    const fill = repeat(' ', Math.max(0, contentWidth - 1 - widthOf(label)));

    return {
      nextScrollOffset: 0,
      block: thinPanelize([line(prompt, span(' '), span(' ', chalk.inverse), span(label, ctx.theme.dimmed), span(fill))], {
        bg: ctx.theme.composerBg(),
        width: ctx.width
      })
    };
  }

  if (slashMode && state.inputChars.length === 1) {
    const label = 'Plan, search, build anything';
    const fill = repeat(' ', Math.max(0, contentWidth - 1 - widthOf(label)));

    return {
      nextScrollOffset: state.scrollOffset,
      block: thinPanelize([line(prompt, span(' '), span('P', chalk.inverse), span(label.slice(1), ctx.theme.dimmed), span(fill))], {
        bg: ctx.theme.composerBg(),
        width: ctx.width
      })
    };
  }

  const inputState = shellMode || slashMode
    ? { ...state, inputChars: state.inputChars.slice(1), cursor: Math.max(0, state.cursor - 1) }
    : state;
  const inputLines = renderInputLines(
    inputState,
    contentWidth,
    slashMode
      ? index => (index < (state.slashCommandLength ?? 0) ? chalk.cyanBright : undefined)
      : undefined
  );
  const block = inputLines.map((entry, index) => line(...(index === 0 ? [prompt, span(' '), ...entry.segments] : [span('  '), ...entry.segments])));

  return {
    nextScrollOffset: 0,
    block: thinPanelize(block, { bg: ctx.theme.composerBg(), width: ctx.width })
  };
}
