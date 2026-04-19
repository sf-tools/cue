import chalk from 'chalk';

import { EntryKind, type ApprovalRequest, type HistoryEntry } from '@/types';
import { takeLast, thinPanelize, wrapTextBlock } from '../layout';
import { blankLine, line, span } from '../primitives';
import { renderHistoryEntry } from './entry';

import type { Block, RenderContext } from '../types';

function clipPreviewText(text: string, ctx: RenderContext, maxLines: number) {
  const maxChars = Math.max(2_000, ctx.width * maxLines * 8);
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

export function renderTranscript(entries: HistoryEntry[], ctx: RenderContext, maxLines = Number.POSITIVE_INFINITY): Block {
  if (!Number.isFinite(maxLines)) return entries.flatMap(entry => [...renderHistoryEntry(entry, ctx), blankLine()]);
  if (maxLines <= 0) return [];

  const blocks: Block[] = [];
  let used = 0;

  for (let index = entries.length - 1; index >= 0 && used < maxLines; index -= 1) {
    const block = [...renderHistoryEntry(entries[index], ctx), blankLine()];
    blocks.push(block);
    used += block.length;
  }

  return blocks.reverse().flat();
}

function renderApprovalNotice(request: ApprovalRequest, ctx: RenderContext): Block {
  const width = Math.max(1, ctx.width - 4);
  const detail = wrapTextBlock(request.detail, width, ctx.theme.dimmed);
  const body = (request.body ?? []).flatMap(text => wrapTextBlock(text, width, ctx.theme.subtle));

  return thinPanelize([
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
  ], { bg: ctx.theme.panelBg(), width: ctx.width });
}

export function renderOutputPreview(
  text: string,
  ctx: RenderContext,
  abortConfirmationPending = false,
  abortRequested = false,
  exitConfirmationPending = false,
  pendingApproval: ApprovalRequest | null = null
): Block {
  if (!text && !abortConfirmationPending && !abortRequested && !exitConfirmationPending && !pendingApproval) return [];

  const maxLines = Math.max(3, ctx.height - 12);
  const previewText = text ? clipPreviewText(text, ctx, maxLines) : '';
  const preview = previewText ? renderHistoryEntry({ type: 'entry', kind: EntryKind.Assistant, text: previewText }, ctx) : [];
  const notice = pendingApproval
    ? [...renderApprovalNotice(pendingApproval, ctx), blankLine()]
    : exitConfirmationPending
      ? [line(span(' '), span('Press Ctrl+C again to exit', chalk.redBright)), blankLine()]
      : abortRequested
        ? [line(span(' '), span('Aborting…', chalk.redBright)), blankLine()]
        : abortConfirmationPending
          ? [line(span(' '), span('Press Esc again to abort', chalk.redBright)), blankLine()]
          : [];

  return [...takeLast(preview, maxLines), ...notice];
}
