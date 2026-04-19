import chalk from 'chalk';

import { EntryKind, type HistoryEntry } from '@/types';
import { LEFT_MARGIN, indent, thinPanelize, wrapTextBlock } from '../layout';
import { line, rawBlock, span } from '../primitives';
import { renderToolHistoryEntry } from './tools';

import type { Block, RenderContext } from '../types';

function renderUserEntry(text: string, ctx: RenderContext): Block {
  return thinPanelize(wrapTextBlock(text, Math.max(1, ctx.width - 2), ctx.theme.foreground), {
    bg: ctx.theme.panelBg(),
    width: ctx.width
  });
}

function renderAssistantEntry(text: string, ctx: RenderContext): Block {
  return indent(wrapTextBlock(text, Math.max(1, ctx.width - 2), ctx.theme.foreground), LEFT_MARGIN);
}

function renderShellEntry(text: string, ctx: RenderContext): Block {
  const match = text.match(/^(.*?)(\s+exit\s+\d+)$/);

  if (!match) {
    return indent(
      wrapTextBlock(text, Math.max(1, ctx.width - 4), ctx.theme.foreground),
      [span(LEFT_MARGIN), span('$ ', ctx.theme.dimmed)],
      `${LEFT_MARGIN}  `
    );
  }

  const [, command, exitText] = match;
  const availableWidth = Math.max(1, ctx.width - 4);
  const commandLines = wrapTextBlock(command, availableWidth, ctx.theme.foreground);
  const lastLine = commandLines.pop();

  if (!lastLine) {
    return indent(
      wrapTextBlock(text, availableWidth, ctx.theme.foreground),
      [span(LEFT_MARGIN), span('$ ', ctx.theme.dimmed)],
      `${LEFT_MARGIN}  `
    );
  }

  const block = [
    ...commandLines,
    line(...lastLine.segments, span(exitText, ctx.theme.dimmed))
  ];

  return indent(block, [span(LEFT_MARGIN), span('$ ', ctx.theme.dimmed)], `${LEFT_MARGIN}  `);
}

function renderErrorEntry(text: string, ctx: RenderContext): Block {
  return indent(wrapTextBlock(text, Math.max(1, ctx.width - 4), chalk.redBright), [span(LEFT_MARGIN), span('! ', chalk.red)], `${LEFT_MARGIN}  `);
}

function renderToolEntry(text: string, ctx: RenderContext): Block {
  return indent(
    wrapTextBlock(text, Math.max(1, ctx.width - 5), ctx.theme.dimmed),
    [span(LEFT_MARGIN), span('· ', ctx.theme.dimmed), span(' ')],
    `${LEFT_MARGIN}   `
  );
}

function renderMetaEntry(text: string, ctx: RenderContext): Block {
  return indent(wrapTextBlock(text, Math.max(1, ctx.width - 2), ctx.theme.dimmed), LEFT_MARGIN);
}

export function renderHistoryEntry(entry: HistoryEntry, ctx: RenderContext): Block {
  if (entry.type === 'tool') return renderToolHistoryEntry(entry, ctx);
  if (entry.type === 'ansi') return indent(rawBlock(entry.text), LEFT_MARGIN);
  if (entry.type === 'plain') return indent(wrapTextBlock(entry.text, Math.max(1, ctx.width)), LEFT_MARGIN);

  if (entry.kind === EntryKind.User) return renderUserEntry(entry.text, ctx);
  if (entry.kind === EntryKind.Assistant) return renderAssistantEntry(entry.text, ctx);
  if (entry.kind === EntryKind.Shell) return renderShellEntry(entry.text, ctx);
  if (entry.kind === EntryKind.Error) return renderErrorEntry(entry.text, ctx);
  if (entry.kind === EntryKind.Tool) return renderToolEntry(entry.text, ctx);

  return renderMetaEntry(entry.text, ctx);
}
