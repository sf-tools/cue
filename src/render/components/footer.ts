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
  const autoRun = state.autoRunEnabled ? 'auto-run' : '';
  const stats = [contextPct, cost, autoRun].filter(Boolean).join(' · ');

  const modeLine = state.pendingApproval
    ? line(
        span(LEFT_MARGIN),
        span(['Approval required', state.pendingApproval.title, queued].filter(Boolean).join(' · '), chalk.yellow)
      )
    : state.busy
      ? state.busyStatusText
        ? line(
            span(LEFT_MARGIN),
            span([`${ctx.commandSpinnerFrame} running ${state.busyStatusText}`, queued].filter(Boolean).join(' · '), chalk.yellow)
          )
        : line(span(LEFT_MARGIN), span([`${ctx.spinnerFrame} Thinking...`, queued].filter(Boolean).join(' · '), ctx.theme.spinnerText))
      : stats
        ? line(span(LEFT_MARGIN), span(stats, ctx.theme.dimmed), span(' · ', ctx.theme.subtle), span(MODEL, chalk.white))
        : line(span(LEFT_MARGIN), span(MODEL, chalk.white));

  const location = ctx.gitBranch ? `${ctx.cwd} · ${ctx.gitBranch}` : ctx.cwd;
  const notice = state.exitConfirmationPending
    ? line(span(LEFT_MARGIN), span('Press Ctrl+C again to exit', chalk.redBright))
    : state.abortRequested
      ? line(span(LEFT_MARGIN), span(['Aborting…', queued].filter(Boolean).join(' · '), chalk.redBright))
      : state.abortConfirmationPending
        ? line(span(LEFT_MARGIN), span('Press Esc again to abort', chalk.redBright))
        : null;

  return [
    line(),
    modeLine,
    line(span(LEFT_MARGIN), span(location.padEnd(Math.max(ctx.width, location.length)), ctx.theme.subtle)),
    ...(notice ? [notice] : [])
  ];
}
