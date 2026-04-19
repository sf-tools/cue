import chalk from 'chalk';

import { EntryKind, type ApprovalRequest, type HistoryEntry } from '@/types';
import { repeat, widthOf } from '@/text';
import { LEFT_MARGIN, takeLast, thinPanelize, wrapTextBlock } from '../layout';
import { blankLine, line, span } from '../primitives';
import { renderHistoryEntry } from './entry';

import type { Block, RenderContext } from '../types';

function clipPreviewText(text: string, ctx: RenderContext, maxLines: number) {
  const maxChars = Math.max(2_000, ctx.width * maxLines * 8);
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

function renderAbortedMetaLine(ctx: RenderContext) {
  const text = '(aborted)';
  return line(span(LEFT_MARGIN), span(repeat(' ', Math.max(0, ctx.width - widthOf(text)))), span(text, ctx.theme.dimmed));
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
      next.text === '(aborted)'
    ) {
      blocks.push([...renderHistoryEntry(entry, ctx), renderAbortedMetaLine(ctx)]);
      index += 1;
      continue;
    }

    blocks.push(renderHistoryEntry(entry, ctx));
  }

  return blocks;
}

export function renderTranscript(entries: HistoryEntry[], ctx: RenderContext, maxLines = Number.POSITIVE_INFINITY): Block {
  const blocks = renderTranscriptBlocks(entries, ctx);

  if (!Number.isFinite(maxLines)) return blocks.flatMap(block => [...block, blankLine()]);
  if (maxLines <= 0) return [];

  const visible: Block[] = [];
  let used = 0;

  for (let index = blocks.length - 1; index >= 0 && used < maxLines; index -= 1) {
    const block = [...blocks[index], blankLine()];
    visible.push(block);
    used += block.length;
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

export function renderOutputPreview(text: string, ctx: RenderContext, pendingApproval: ApprovalRequest | null = null): Block {
  if (!text && !pendingApproval) return [];

  const maxLines = Math.max(3, ctx.height - 12);
  const previewText = text ? clipPreviewText(text, ctx, maxLines) : '';
  const preview = previewText ? renderHistoryEntry({ type: 'entry', kind: EntryKind.Assistant, text: previewText }, ctx) : [];
  const notice = pendingApproval ? [...renderApprovalNotice(pendingApproval, ctx), blankLine()] : [];

  return [...takeLast(preview, maxLines), ...notice];
}
