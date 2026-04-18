import { EntryKind, type HistoryEntry } from '@/types';
import { takeLast } from '../layout';
import { blankLine } from '../primitives';
import { renderHistoryEntry } from './entry';

import type { Block, RenderContext } from '../types';

export function renderTranscript(entries: HistoryEntry[], ctx: RenderContext): Block {
  return entries.flatMap(entry => [...renderHistoryEntry(entry, ctx), blankLine()]);
}

export function renderOutputPreview(text: string, ctx: RenderContext): Block {
  if (!text) return [];

  const maxLines = Math.max(3, ctx.height - 12);
  const preview = renderHistoryEntry({ type: 'entry', kind: EntryKind.Assistant, text }, ctx);
  return [...takeLast(preview, maxLines), blankLine()];
}
