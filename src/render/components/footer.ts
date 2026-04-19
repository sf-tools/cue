import chalk from 'chalk';
import approx from 'approximate-number';

import { formatThinkingMode, getContextWindow, getOpenAIModelDisplayName, isReasoningCapableOpenAIModel } from '@/config';
import { line, span } from '../primitives';
import { LEFT_MARGIN } from '../layout';

import type { AgentState } from '@/store';
import type { Block, RenderContext } from '../types';

function thinkingModeStyle(mode: AgentState['thinkingMode']) {
  switch (mode) {
    case 'auto':
      return chalk.cyanBright;
    case 'low':
      return chalk.greenBright;
    case 'medium':
      return chalk.yellowBright;
    case 'high':
      return chalk.redBright;
  }
}

export function renderFooter(state: AgentState, ctx: RenderContext): Block {
  const contextWindow = getContextWindow(state.currentModel);
  const ctxLabel = approx(contextWindow, { capital: false, precision: 2 });
  const inputLabel = state.lastPromptTokens > 0 ? approx(state.lastPromptTokens, { capital: false, precision: 2 }) : '';
  const pct = contextWindow > 0 ? (state.lastPromptTokens / contextWindow) * 100 : 0;
  const contextPct =
    state.lastPromptTokens > 0 ? `${inputLabel} / ${ctxLabel} ctx${contextWindow > 0 ? ` (${pct < 1 ? '<1' : Math.round(pct)}%)` : ''}` : '';
  const output = state.lastOutputTokens > 0 ? `${approx(state.lastOutputTokens, { capital: false, precision: 2 })} out` : '';
  const reasoning = state.lastReasoningTokens > 0 ? `${approx(state.lastReasoningTokens, { capital: false, precision: 2 })} reasoning` : '';
  const cost = state.totalCost > 0 ? `$${state.totalCost.toFixed(4)}` : '';
  const queued = state.queuedSubmissions.length > 0 ? `${state.queuedSubmissions.length} queued` : '';
  const autoRun = state.autoRunEnabled ? 'auto-run' : '';
  const autoCompact = state.autoCompactEnabled ? '' : 'auto-compact off';
  const modelName = getOpenAIModelDisplayName(state.currentModel);
  const stats = [contextPct, output, reasoning, cost, autoRun, autoCompact].filter(Boolean).join(' · ');

  const modeLine = state.pendingApproval
    ? line(span(LEFT_MARGIN), span(['Approval required', state.pendingApproval.title, queued].filter(Boolean).join(' · '), chalk.yellow))
    : state.compacting
      ? line(span(LEFT_MARGIN), span([`${ctx.commandSpinnerFrame} Compacting...`, queued].filter(Boolean).join(' · '), chalk.yellow))
      : state.busy
        ? state.busyStatusText
          ? line(
              span(LEFT_MARGIN),
              span([`${ctx.commandSpinnerFrame} running ${state.busyStatusText}`, queued].filter(Boolean).join(' · '), chalk.yellow)
            )
          : line(span(LEFT_MARGIN), span([`${ctx.spinnerFrame} Thinking...`, queued].filter(Boolean).join(' · '), ctx.theme.spinnerText))
        : stats
          ? line(
              span(LEFT_MARGIN),
              span(stats, ctx.theme.dimmed),
              span(' · ', ctx.theme.subtle),
              span(modelName, chalk.white),
              ...(isReasoningCapableOpenAIModel(state.currentModel)
                ? [span(' · ', ctx.theme.subtle), span(formatThinkingMode(state.thinkingMode), thinkingModeStyle(state.thinkingMode))]
                : [])
            )
          : line(
              span(LEFT_MARGIN),
              span(modelName, chalk.white),
              ...(isReasoningCapableOpenAIModel(state.currentModel)
                ? [span(' · ', ctx.theme.subtle), span(formatThinkingMode(state.thinkingMode), thinkingModeStyle(state.thinkingMode))]
                : [])
            );

  const location = ctx.gitBranch ? `${ctx.cwd} · ${ctx.gitBranch}` : ctx.cwd;
  const notice = state.exitConfirmationPending
    ? line(span(LEFT_MARGIN), span('Press Ctrl+C again to exit', chalk.redBright))
    : state.abortRequested
      ? line(span(LEFT_MARGIN), span(['Aborting…', queued].filter(Boolean).join(' · '), chalk.redBright))
      : state.abortConfirmationPending
        ? line(span(LEFT_MARGIN), span('Press Esc again to abort', chalk.redBright))
        : state.footerNotice
          ? line(span(LEFT_MARGIN), span(state.footerNotice, chalk.hex('#8ab4ff')))
          : null;

  return [
    line(),
    modeLine,
    line(span(LEFT_MARGIN), span(location.padEnd(Math.max(ctx.width, location.length)), ctx.theme.subtle)),
    ...(notice ? [line(), notice] : [])
  ];
}
