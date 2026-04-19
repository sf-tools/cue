import chalk from 'chalk';

import { EntryKind, type ApprovalRequest } from '@/types';
import { LEFT_MARGIN, thinPanelize, wrapTextBlock, takeLast } from '../layout';
import { blankLine, line, span } from '../primitives';
import { renderHistoryEntry } from './entry';

import type { Block, RenderContext } from '../types';

function clipPreviewText(text: string, ctx: RenderContext, maxLines: number) {
  const maxChars = Math.max(2_000, ctx.width * maxLines * 8);
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
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
