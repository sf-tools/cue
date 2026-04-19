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

function formatUsageSummary(state: AgentState) {
  const promptTokens = state.busy ? state.livePromptTokens : state.lastPromptTokens;
  const outputTokens = state.busy ? state.liveOutputTokens : state.lastOutputTokens;
  const reasoningTokens = state.busy ? state.liveReasoningTokens : state.lastReasoningTokens;
  const hasUsage = promptTokens > 0 || outputTokens > 0 || reasoningTokens > 0;
  if (!hasUsage) return '';

  const contextWindow = getContextWindow(state.currentModel);
  const input = approx(promptTokens, { capital: false, precision: 2 });
  const output = approx(outputTokens, { capital: false, precision: 2 });
  const context = approx(contextWindow, { capital: false, precision: 2 });
  const pct = contextWindow > 0 ? (promptTokens / contextWindow) * 100 : 0;
  const pctLabel = contextWindow > 0 ? (pct < 1 ? '<1%' : `${Math.round(pct)}%`) : 'n/a';

  return `↑${input} ↓${output} / ${context} (${pctLabel})`;
}

export function renderFooter(state: AgentState, ctx: RenderContext): Block {
  const queued = state.queuedSubmissions.length > 0 ? `${state.queuedSubmissions.length} queued` : '';
  const usage = formatUsageSummary(state);
  const cost = state.totalCost > 0 ? `$${state.totalCost.toFixed(4)}` : '';
  const autoRun = state.autoRunEnabled ? 'auto-run' : '';
  const autoCompact = state.autoCompactEnabled ? '' : 'auto-compact off';
  const modelName = getOpenAIModelDisplayName(state.currentModel);
  const stats = [usage, cost, autoRun, autoCompact].filter(Boolean).join(' · ');
  const statsLine = stats
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

  const modeLine = state.pendingApproval
    ? line(span(LEFT_MARGIN), span(['Approval required', state.pendingApproval.title, queued].filter(Boolean).join(' · '), chalk.yellow))
    : state.compacting
      ? line(span(LEFT_MARGIN), span([`${ctx.commandSpinnerFrame} Compacting...`, queued].filter(Boolean).join(' · '), chalk.yellow))
      : state.busy && state.busyStatusText
        ? line(
            span(LEFT_MARGIN),
            span([`${ctx.commandSpinnerFrame} running ${state.busyStatusText}`, queued].filter(Boolean).join(' · '), chalk.yellow)
          )
        : statsLine;

  const location = ctx.gitBranch ? `${ctx.cwd} · ${ctx.gitBranch}` : ctx.cwd;
  const notice = state.exitConfirmationPending
    ? line(span(LEFT_MARGIN), span('Press Ctrl+C again to exit', chalk.redBright))
    : state.steerRequested
      ? line(span(LEFT_MARGIN), span(['Steering…', queued].filter(Boolean).join(' · '), chalk.yellow))
      : state.abortRequested
        ? line(span(LEFT_MARGIN), span(['Aborting…', queued].filter(Boolean).join(' · '), chalk.redBright))
        : state.abortConfirmationPending
          ? line(span(LEFT_MARGIN), span('Press Esc again to abort', chalk.redBright))
          : state.footerNotice
            ? line(span(LEFT_MARGIN), span(state.footerNotice, chalk.hex('#8ab4ff')))
            : state.busy && !state.busyStatusText
              ? line(
                  span(LEFT_MARGIN),
                  span(`${ctx.spinnerFrame} Thinking...`, ctx.theme.spinnerText),
                  ...(queued ? [span(' · ', ctx.theme.subtle), span(queued, chalk.yellow)] : [])
                )
              : null;

  return [
    line(),
    modeLine,
    line(span(LEFT_MARGIN), span(location.padEnd(Math.max(ctx.width, location.length)), ctx.theme.subtle)),
    ...(notice ? [line(), notice] : [])
  ];
}
