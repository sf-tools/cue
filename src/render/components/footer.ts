import chalk from 'chalk';
import approx from 'approximate-number';

import { CONTEXT_WINDOW, MODEL } from '@/config';
import { line, span } from '../primitives';
import { LEFT_MARGIN } from '../layout';

import type { AgentState } from '@/store';
import type { Block, RenderContext } from '../types';

export function renderFooter(state: AgentState, ctx: RenderContext): Block {
  const ctxLabel = approx(CONTEXT_WINDOW, { capital: false, precision: 2 });
  const pct = (state.lastPromptTokens / CONTEXT_WINDOW) * 100;
  const contextPct = state.lastPromptTokens > 0 ? `${pct < 1 ? '<1' : Math.round(pct)}% of ${ctxLabel}` : '';
  const cost = state.totalCost > 0 ? `$${state.totalCost.toFixed(4)}` : '';
  const queued = state.queuedSubmissions.length > 0 ? `${state.queuedSubmissions.length} queued` : '';
  const stats = [contextPct, cost].filter(Boolean).join(' · ');

  const modeLine = state.abortRequested
    ? line(span(LEFT_MARGIN), span(['Aborting…', queued].filter(Boolean).join(' · '), chalk.redBright))
    : state.busy
      ? line(span(LEFT_MARGIN), span([`${ctx.spinnerFrame} Thinking...`, queued].filter(Boolean).join(' · '), ctx.theme.spinnerText))
      : stats
        ? line(span(LEFT_MARGIN), span(stats, ctx.theme.dimmed), span(' · ', ctx.theme.subtle), span(MODEL, ctx.theme.foreground))
        : line(span(LEFT_MARGIN), span(MODEL, ctx.theme.foreground));

  return [line(), modeLine, line(span(LEFT_MARGIN), span(ctx.cwd.padEnd(Math.max(ctx.width, ctx.cwd.length)), ctx.theme.subtle))];
}
