import chalk from 'chalk';

import { EntryKind, type HistoryEntry } from '@/types';
import { takeLast } from '../layout';
import { blankLine, line, span } from '../primitives';
import { renderHistoryEntry } from './entry';

import type { Block, RenderContext } from '../types';

export function renderTranscript(entries: HistoryEntry[], ctx: RenderContext): Block {
  return entries.flatMap(entry => [...renderHistoryEntry(entry, ctx), blankLine()]);
}

export function renderOutputPreview(text: string, ctx: RenderContext, abortConfirmationPending = false, abortRequested = false): Block {
  if (!text && !abortConfirmationPending && !abortRequested) return [];

  const maxLines = Math.max(3, ctx.height - 12);
  const preview = text ? renderHistoryEntry({ type: 'entry', kind: EntryKind.Assistant, text }, ctx) : [];
  const notice = abortRequested
    ? [line(span(' '), span('Aborting…', chalk.redBright)), blankLine()]
    : abortConfirmationPending
      ? [line(span(' '), span('Press Esc again to abort', chalk.redBright)), blankLine()]
      : [];

  return [...takeLast(preview, maxLines), ...notice];
}
