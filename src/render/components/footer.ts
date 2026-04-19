import chalk from 'chalk';
import approx from 'approximate-number';

import { formatThinkingMode, getContextWindow, getOpenAIModelDisplayName, isReasoningCapableOpenAIModel } from '@/config';
import { line, span } from '../primitives';
import { LEFT_MARGIN } from '../layout';

import type { AgentState } from '@/store';
import type { Block, RenderContext, Segment, StyledLine } from '../types';

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

function joinFooterParts(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(' · ');
}

function buildStatsLine(state: AgentState, ctx: RenderContext, footerPrefix: Segment[], usage: string, cost: string, autoCompact: string) {
  const modelName = getOpenAIModelDisplayName(state.currentModel);
  const statsSegments = [...footerPrefix];
  let hasStats = false;

  const appendStat = (text: string, style = ctx.theme.dimmed) => {
    if (!text) return;
    if (hasStats) statsSegments.push(span(' · ', ctx.theme.subtle));
    statsSegments.push(span(text, style));
    hasStats = true;
  };

  appendStat(usage);
  appendStat(cost);
  appendStat(autoCompact);

  return hasStats
    ? line(
        ...statsSegments,
        span(' · ', ctx.theme.subtle),
        span(modelName, chalk.white),
        ...(isReasoningCapableOpenAIModel(state.currentModel)
          ? [span(' · ', ctx.theme.subtle), span(formatThinkingMode(state.thinkingMode), thinkingModeStyle(state.thinkingMode))]
          : [])
      )
    : line(
        ...footerPrefix,
        span(modelName, chalk.white),
        ...(isReasoningCapableOpenAIModel(state.currentModel)
          ? [span(' · ', ctx.theme.subtle), span(formatThinkingMode(state.thinkingMode), thinkingModeStyle(state.thinkingMode))]
          : [])
      );
}

function buildModeLine(state: AgentState, ctx: RenderContext, footerPrefix: Segment[], queued: string, statsLine: StyledLine) {
  if (state.pendingApproval) {
    return line(...footerPrefix, span(joinFooterParts('Approval required', state.pendingApproval.title, queued), chalk.yellow));
  }

  if (state.compacting) {
    return line(...footerPrefix, span(joinFooterParts(`${ctx.commandSpinnerFrame} Compacting...`, queued), chalk.yellow));
  }

  if (state.busy && state.busyStatusText) {
    return line(...footerPrefix, span(joinFooterParts(`${ctx.commandSpinnerFrame} running ${state.busyStatusText}`, queued), chalk.yellow));
  }

  return statsLine;
}

function buildNoticeLine(state: AgentState, ctx: RenderContext, queued: string) {
  if (state.exitConfirmationPending) {
    return line(span(LEFT_MARGIN), span('Press Ctrl+C again to exit', chalk.redBright));
  }

  if (state.steerRequested) {
    return line(span(LEFT_MARGIN), span(joinFooterParts('Steering…', queued), chalk.yellow));
  }

  if (state.abortRequested) {
    return line(span(LEFT_MARGIN), span(joinFooterParts('Aborting…', queued), chalk.redBright));
  }

  if (state.abortConfirmationPending) {
    return line(span(LEFT_MARGIN), span('Press Esc again to abort', chalk.redBright));
  }

  if (state.footerNotice) {
    return line(span(LEFT_MARGIN), span(state.footerNotice, chalk.hex('#8ab4ff')));
  }

  if (state.busy && !state.busyStatusText) {
    return line(
      span(LEFT_MARGIN),
      span(`${ctx.spinnerFrame} Thinking...`, ctx.theme.spinnerText),
      ...(queued ? [span(' · ', ctx.theme.subtle), span(queued, chalk.yellow)] : [])
    );
  }

  return null;
}

export function renderFooter(state: AgentState, ctx: RenderContext): Block {
  const queued = state.queuedSubmissions.length > 0 ? `${state.queuedSubmissions.length} queued` : '';
  const usage = formatUsageSummary(state);
  const cost = state.totalCost > 0 ? `$${state.totalCost.toFixed(4)}` : '';
  const autoCompact = state.autoCompactEnabled ? '' : 'auto-compact off';
  const footerPrefix = [span(LEFT_MARGIN), ...(state.autoRunEnabled ? [span('!', chalk.redBright), span(' ')] : [])];
  const statsLine = buildStatsLine(state, ctx, footerPrefix, usage, cost, autoCompact);
  const modeLine = buildModeLine(state, ctx, footerPrefix, queued, statsLine);

  const location = ctx.gitBranch ? `${ctx.cwd} · ${ctx.gitBranch}` : ctx.cwd;
  const locationLine = line(span(LEFT_MARGIN), span(location.padEnd(Math.max(ctx.width, location.length)), ctx.theme.subtle));
  const notice = buildNoticeLine(state, ctx, queued);

  return [line(), modeLine, locationLine, ...(notice ? [line(), notice] : [])];
}
