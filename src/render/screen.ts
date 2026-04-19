import { diffFrames } from './diff';
import { takeLast } from './layout';
import { blankLine, vstack } from './primitives';
import { formatWorkspacePath } from '@/text';
import { serializeBlock } from './serialize';
import { renderFooter } from './components/footer';
import { renderHeader } from './components/header';
import { renderComposer } from './components/composer';
import { renderQueuedSubmissions } from './components/queued';
import { renderSuggestions } from './components/suggestions';
import { renderOutputPreview, renderTranscript } from './components/transcript';
import { getCachedGitBranch, refreshGitBranch } from '@/git';

import type { AgentState } from '@/store';
import type { ComposerSuggestion } from '@/agent/composer-suggestions';
import type { Frame, RenderContext } from './types';
import type { ThemePalette } from '@/theme';

export function frameWidth(columns = process.stdout.columns || 100) {
  return Math.max(40, columns - 2);
}

export function createRenderContext(
  theme: ThemePalette,
  spinnerFrame: string,
  commandSpinnerFrame: string,
  columns = process.stdout.columns || 100,
  rows = process.stdout.rows || 30
): RenderContext {
  const cwd = process.cwd();
  void refreshGitBranch(cwd);

  return {
    width: frameWidth(columns),
    height: rows,
    cwd: formatWorkspacePath(cwd),
    gitBranch: getCachedGitBranch(cwd),
    spinnerFrame,
    commandSpinnerFrame,
    theme
  };
}

export function renderScreen(
  state: AgentState,
  ctx: RenderContext,
  suggestions: ComposerSuggestion[],
  slashCommandLength = 0,
  previousFrame: Frame | null = null
) {
  const header = renderHeader(ctx);
  const preview = renderOutputPreview(
    state.liveAssistantText,
    ctx,
    state.abortConfirmationPending,
    state.abortRequested,
    state.exitConfirmationPending
  );
  const composer = renderComposer({
    inputChars: state.inputChars,
    cursor: state.cursor,
    scrollOffset: state.scrollOffset,
    slashCommandLength,
    showCapabilitiesHint: state.historyEntries.length === 0
  }, ctx);
  const suggestionLines = renderSuggestions(suggestions, state.selectedSuggestion, ctx);
  const footer = renderFooter(state, ctx);

  const reserved = header.length + composer.block.length + suggestionLines.length + footer.length;
  const available = Math.max(0, ctx.height - reserved);
  const queued = renderQueuedSubmissions(state.queuedSubmissions, ctx, Math.min(8, Math.max(0, available - preview.length)));
  const queuePadding = queued.length > 0 ? 2 : 0;
  const transcript = renderTranscript(state.historyEntries, ctx, Math.max(0, available - preview.length - queued.length - queuePadding));
  const bodySections = [transcript, preview];

  if (queued.length > 0) {
    if (transcript.length > 0 || preview.length > 0) bodySections.push([blankLine()]);
    bodySections.push(queued, [blankLine()]);
  }

  const body = takeLast(vstack(...bodySections), available);
  const frame = { lines: serializeBlock(vstack(header, body, composer.block, suggestionLines, footer)) };

  return {
    frame,
    diff: diffFrames(previousFrame, frame),
    nextScrollOffset: composer.nextScrollOffset
  };
}
