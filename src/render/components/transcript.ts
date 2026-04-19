import chalk from 'chalk';

import { EntryKind, type ApprovalRequest, type HistoryEntry } from '@/types';
import { repeat, widthOf } from '@/text';
import { LEFT_MARGIN, takeLast, thinPanelize, wrapTextBlock } from '../layout';
import { blankLine, line, span } from '../primitives';
import { renderHistoryEntry } from './entry';

import type { Block, RenderContext } from '../types';

const RAINBOW_PHRASE_PATTERN = /you'?re absolutely right/i;
const transcriptBlockCache = new WeakMap<HistoryEntry, Map<number, Block>>();

function clipPreviewText(text: string, ctx: RenderContext, maxLines: number) {
  const maxChars = Math.max(2_000, ctx.width * maxLines * 8);
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

function renderTerminalMetaLine(text: string, ctx: RenderContext) {
  const style = text === '(steered)' ? (value: string) => chalk.italic(ctx.theme.dimmed(value)) : ctx.theme.dimmed;
  return line(span(LEFT_MARGIN), span(repeat(' ', Math.max(0, ctx.width - widthOf(text)))), span(text, style));
}

function isDynamicHistoryEntry(entry: HistoryEntry) {
  if (entry.type === 'tool') return entry.status === 'running';
  return entry.type === 'entry' && entry.kind === EntryKind.Assistant && RAINBOW_PHRASE_PATTERN.test(entry.text);
}

function renderCachedHistoryEntry(entry: HistoryEntry, ctx: RenderContext) {
  if (isDynamicHistoryEntry(entry)) return renderHistoryEntry(entry, ctx);

  const cachedByWidth = transcriptBlockCache.get(entry);
  const cached = cachedByWidth?.get(ctx.width);
  if (cached) return cached;

  const block = renderHistoryEntry(entry, ctx);
  const nextCachedByWidth = cachedByWidth ?? new Map<number, Block>();
  nextCachedByWidth.set(ctx.width, block);
  if (!cachedByWidth) transcriptBlockCache.set(entry, nextCachedByWidth);
  return block;
}

function renderTranscriptBlocks(entries: HistoryEntry[], ctx: RenderContext): Block[] {
  const blocks: Block[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const next = entries[index + 1];

    if (
      entry.type === 'entry' &&
      entry.kind === EntryKind.Assistant &&
      next?.type === 'entry' &&
      next.kind === EntryKind.Meta &&
      ['(aborted)', '(steered)'].includes(next.text)
    ) {
      blocks.push([...renderCachedHistoryEntry(entry, ctx), renderTerminalMetaLine(next.text, ctx)]);
      index += 1;
      continue;
    }

    blocks.push(renderCachedHistoryEntry(entry, ctx));
  }

  return blocks;
}

export function renderTranscript(entries: HistoryEntry[], ctx: RenderContext, maxLines = Number.POSITIVE_INFINITY): Block {
  if (!Number.isFinite(maxLines)) return renderTranscriptBlocks(entries, ctx).flatMap(block => [...block, blankLine()]);
  if (maxLines <= 0) return [];

  const visible: Block[] = [];
  let used = 0;

  for (let index = entries.length - 1; index >= 0 && used < maxLines; index -= 1) {
    const entry = entries[index];
    const previous = entries[index - 1];

    let block: Block;

    if (
      entry.type === 'entry' &&
      entry.kind === EntryKind.Meta &&
      ['(aborted)', '(steered)'].includes(entry.text) &&
      previous?.type === 'entry' &&
      previous.kind === EntryKind.Assistant
    ) {
      block = [...renderCachedHistoryEntry(previous, ctx), renderTerminalMetaLine(entry.text, ctx)];
      index -= 1;
    } else block = renderCachedHistoryEntry(entry, ctx);

    visible.push([...block, blankLine()]);
    used += block.length + 1;
  }

  return visible.reverse().flat();
}

function renderApprovalNotice(request: ApprovalRequest, ctx: RenderContext): Block {
  const width = Math.max(1, ctx.width - 4);
  const detail = wrapTextBlock(request.detail, width, ctx.theme.dimmed);
  const body = (request.body ?? []).flatMap(text => wrapTextBlock(text, width, ctx.theme.subtle));

  return thinPanelize(
    [
      line(span('Approval required', chalk.yellow)),
      line(span(request.title, ctx.theme.foreground)),
      ...detail,
      ...(body.length > 0 ? [blankLine(), ...body] : []),
      blankLine(),
      line(
        span('[y] once', chalk.yellow),
        span(' · ', ctx.theme.subtle),
        span('[s] this session', chalk.yellow),
        span(' · ', ctx.theme.subtle),
        span('[n] deny', chalk.redBright)
      )
    ],
    { bg: ctx.theme.panelBg(), width: ctx.width }
  );
}

export function renderOutputPreview(reasoningText: string, text: string, ctx: RenderContext, pendingApproval: ApprovalRequest | null = null): Block {
  if (!reasoningText && !text && !pendingApproval) return [];

  const maxLines = Math.max(3, ctx.height - 12);
  const previewBlocks: Block[] = [];

  if (reasoningText) {
    const clippedReasoning = clipPreviewText(reasoningText, ctx, maxLines);
    previewBlocks.push(renderHistoryEntry({ type: 'entry', kind: EntryKind.Reasoning, text: clippedReasoning }, ctx));
  }

  if (text) {
    const previewText = clipPreviewText(text, ctx, maxLines);
    previewBlocks.push(renderHistoryEntry({ type: 'entry', kind: EntryKind.Assistant, text: previewText }, ctx));
  }

  const preview = previewBlocks.flatMap((block, index) => (index === 0 ? block : [blankLine(), ...block]));
  const notice = pendingApproval ? [...renderApprovalNotice(pendingApproval, ctx), blankLine()] : [];

  return [...takeLast(preview, maxLines), ...notice];
}
