import chalk from 'chalk';

import { plain } from '@/text';
import { panelize, wrapTextBlock } from '@/render/layout';
import { line, span } from '@/render/primitives';
import type { ToolHistoryEntry } from '@/types';
import type { Block, RenderContext } from '@/render/types';

export type ToolRenderer = (entry: ToolHistoryEntry, ctx: RenderContext) => Block;

type ToolCardOptions = {
  name: string;
  detail?: string;
  body?: string[];
  status: ToolHistoryEntry['status'];
};

export function asRecord(value: unknown) {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function stringProp(value: unknown, key: string) {
  const record = asRecord(value);
  return record && typeof record[key] === 'string' ? record[key] : null;
}

export function numberProp(value: unknown, key: string) {
  const record = asRecord(value);
  return record && typeof record[key] === 'number' ? record[key] : null;
}

export function arrayProp(value: unknown, key: string) {
  const record = asRecord(value);
  return record && Array.isArray(record[key]) ? record[key] : null;
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function previewText(text: string, maxLines = 6) {
  const lines = plain(text).split('\n');
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`];
}

export function previewJson(value: unknown) {
  try {
    return previewText(JSON.stringify(value, null, 2), 8);
  } catch {
    return [String(value)];
  }
}

export function renderToolCard({ name, detail, body = [], status }: ToolCardOptions, ctx: RenderContext): Block {
  const statusStyle = status === 'failed' ? chalk.redBright : status === 'running' ? ctx.theme.spinnerText : ctx.theme.dimmed;
  const statusLabel = status === 'failed' ? 'failed' : status === 'running' ? `${ctx.spinnerFrame} running` : 'done';
  const bodyStyle = status === 'failed' ? chalk.redBright : ctx.theme.dimmed;
  const width = Math.max(1, ctx.width - 4);

  const header = line(
    span('⌁ ', ctx.theme.subtle),
    span(name, ctx.theme.foreground),
    ...(detail ? [span(' · ', ctx.theme.subtle), span(detail, ctx.theme.dimmed)] : []),
    span(' · ', ctx.theme.subtle),
    span(statusLabel, statusStyle)
  );

  const bodyBlock = body.flatMap(text => wrapTextBlock(text, width, bodyStyle).map(part => line(span('  '), ...part.segments)));

  return panelize([header, ...bodyBlock], { bg: ctx.theme.panelBg(), width: ctx.width });
}
