import { diffFrames } from './diff';
import { takeLast } from './layout';
import { vstack } from './primitives';
import { formatWorkspacePath } from '@/text';
import { serializeBlock } from './serialize';
import { renderFooter } from './components/footer';
import { renderHeader } from './components/header';
import { renderComposer } from './components/composer';
import { renderSuggestions } from './components/suggestions';
import { renderOutputPreview, renderTranscript } from './components/transcript';

import type { AgentState } from '@/store';
import type { Frame, RenderContext } from './types';
import type { ThemePalette } from '@/theme';

export function frameWidth(columns = process.stdout.columns || 100) {
  return Math.max(40, columns - 2);
}

export function createRenderContext(
  theme: ThemePalette,
  spinnerFrame: string,
  columns = process.stdout.columns || 100,
  rows = process.stdout.rows || 30
): RenderContext {
  return {
    width: frameWidth(columns),
    height: rows,
    cwd: formatWorkspacePath(process.cwd()),
    spinnerFrame,
    theme
  };
}

export function renderScreen(state: AgentState, ctx: RenderContext, suggestions: string[], previousFrame: Frame | null = null) {
  const header = renderHeader(ctx);
  const transcript = renderTranscript(state.historyEntries, ctx);
  const preview = renderOutputPreview(state.liveAssistantText, ctx, state.abortConfirmationPending, state.abortRequested);
  const composer = renderComposer({ inputChars: state.inputChars, cursor: state.cursor, scrollOffset: state.scrollOffset }, ctx);
  const suggestionLines = renderSuggestions(suggestions, state.selectedSuggestion, ctx);
  const footer = renderFooter(state, ctx);

  const reserved = header.length + composer.block.length + suggestionLines.length + footer.length;
  const available = Math.max(0, ctx.height - reserved);
  const body = takeLast(vstack(transcript, preview), available);
  const frame = { lines: serializeBlock(vstack(header, body, composer.block, suggestionLines, footer)) };

  return {
    frame,
    diff: diffFrames(previousFrame, frame),
    nextScrollOffset: composer.nextScrollOffset
  };
}
