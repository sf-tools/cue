import chalk from 'chalk';
import approx from 'approximate-number';

import { EntryKind } from './types';
import type { AgentState } from '@/store';
import type { ThemePalette } from './theme';
import { APP_NAME, APP_VERSION, CONTEXT_WINDOW, MODEL } from '@/config';
import { formatWorkspacePath, repeat, widthOf, wrapText } from './text';

const LEFT_MARGIN = ' ';

export function frameWidth() {
  const cols = process.stdout.columns || 100;
  return Math.max(40, cols - 2);
}

function panelLine(text: string, theme: ThemePalette, width: number) {
  const fill = repeat(' ', Math.max(0, width - widthOf(text) - 2));
  return `${LEFT_MARGIN}${chalk.bgHex(theme.panelBg())(` ${text}${fill} `)}`;
}

function charWidth(ch: string) {
  return Math.max(1, widthOf(ch));
}

function normalizeScroll(state: AgentState, viewWidth: number) {
  if (state.cursor < state.scrollOffset) state.scrollOffset = state.cursor;

  let used = 0;
  for (let i = state.cursor - 1; i >= state.scrollOffset; i--) used += charWidth(state.inputChars[i]);

  while (used > viewWidth && state.scrollOffset < state.cursor) {
    used -= charWidth(state.inputChars[state.scrollOffset]);
    state.scrollOffset += 1;
  }
}

function renderInputContent(state: AgentState, viewWidth: number) {
  normalizeScroll(state, viewWidth);

  let used = 0;
  let end = state.scrollOffset;

  while (end < state.inputChars.length) {
    const w = charWidth(state.inputChars[end]);
    if (used + w > viewWidth) break;
    used += w;
    end += 1;
  }

  const visibleChars = state.inputChars.slice(state.scrollOffset, end);
  const cursorIndex = Math.max(0, Math.min(visibleChars.length, state.cursor - state.scrollOffset));
  const activeChar = visibleChars[cursorIndex] ?? ' ';

  const before = visibleChars.slice(0, cursorIndex).join('');
  const after = visibleChars.slice(cursorIndex + (cursorIndex < visibleChars.length ? 1 : 0)).join('');

  const cursorCell = chalk.inverse(activeChar);
  const rendered = `${before}${cursorCell}${after}`;
  const visibleWidth = widthOf(visibleChars.join('')) + (cursorIndex >= visibleChars.length ? 1 : 0);

  return { rendered, fill: repeat(' ', Math.max(0, viewWidth - visibleWidth)) };
}

export function renderEntry(kind: EntryKind, text: string, theme: ThemePalette, width = frameWidth()) {
  if (kind === EntryKind.User) {
    return wrapText(text, Math.max(1, width - 2)).map(line => panelLine(theme.foreground(line), theme, width));
  }

  const pad = LEFT_MARGIN;
  const baseWidth = Math.max(1, width - 2);

  if (kind === EntryKind.Assistant) {
    return wrapText(text, baseWidth).map(line => `${pad}${theme.foreground(line)}`);
  }

  if (kind === EntryKind.Shell)
    return wrapText(text, Math.max(1, baseWidth - 2)).map(
      (line, index) => `${pad}${index === 0 ? theme.dimmed('$ ') : '  '}${theme.foreground(line)}`
    );

  if (kind === EntryKind.Error) {
    return wrapText(text, Math.max(1, baseWidth - 2)).map((line, index) => `${pad}${index === 0 ? chalk.red('! ') : '  '}${chalk.redBright(line)}`);
  }

  const prefix = kind === EntryKind.Tool ? `${theme.dimmed('· ')} ` : '';
  const indent = repeat(' ', widthOf(prefix));

  return wrapText(text, Math.max(1, baseWidth - widthOf(prefix))).map((line, index) => `${pad}${index === 0 ? prefix : indent}${theme.dimmed(line)}`);
}

export function renderHeader(theme: ThemePalette) {
  const pad = LEFT_MARGIN;
  return ['', `${pad}${theme.foreground(chalk.bold(APP_NAME))}`, `${pad}${theme.dimmed(APP_VERSION)}`, ''];
}

export function renderOutputPreview(state: AgentState, theme: ThemePalette) {
  if (!state.liveAssistantText) return [];

  const maxLines = Math.max(3, (process.stdout.rows || 24) - 12);
  const lines = renderEntry(EntryKind.Assistant, state.liveAssistantText, theme);
  return [...lines.slice(-maxLines), ''];
}

export function renderComposer(state: AgentState, theme: ThemePalette, width = frameWidth()) {
  const pad = LEFT_MARGIN;
  const contentWidth = Math.max(1, width - 4);
  const prompt = state.inputChars.length === 0 ? theme.dimmed('→') : theme.foreground('→');

  if (state.inputChars.length === 0) {
    const placeholder = `${chalk.inverse('P')}${theme.dimmed('lan, search, build anything')}`;
    const fill = repeat(' ', Math.max(0, contentWidth - 1 - widthOf('Plan, search, build anything')));
    return [`${pad}${chalk.bgHex(theme.composerBg())(` ${prompt} ${placeholder}${fill} `)}`];
  }

  const { rendered, fill } = renderInputContent(state, contentWidth);
  return [`${pad}${chalk.bgHex(theme.composerBg())(` ${prompt} ${rendered}${fill} `)}`];
}

export function renderSuggestions(theme: ThemePalette, suggestions: string[], selectedSuggestion: number) {
  if (suggestions.length === 0) return [];

  const pad = LEFT_MARGIN;
  return suggestions.map((suggestion, index) =>
    index === selectedSuggestion ? `${pad}${theme.foreground('→')} ${theme.foreground(suggestion)}` : `${pad}  ${theme.dimmed(suggestion)}`
  );
}

export function renderFooter(state: AgentState, theme: ThemePalette, spinnerFrame: string, width = frameWidth()) {
  const cwd = formatWorkspacePath(process.cwd());
  const ctxLabel = approx(CONTEXT_WINDOW, { capital: false, precision: 2 });
  const pct = (state.lastPromptTokens / CONTEXT_WINDOW) * 100;

  const contextPct = state.lastPromptTokens > 0 ? `${pct < 1 ? '<1' : Math.round(pct)}% of ${ctxLabel}` : '';
  const cost = state.totalCost > 0 ? `$${state.totalCost.toFixed(4)}` : '';
  const stats = [contextPct, cost].filter(Boolean).join(' · ');

  const modeText = state.busy
    ? theme.spinnerText(`${spinnerFrame} Thinking...`)
    : stats
      ? `${theme.dimmed(stats)} ${theme.subtle('·')} ${theme.foreground(MODEL)}`
      : theme.foreground(MODEL);

  return ['', `${LEFT_MARGIN}${modeText}`, `${LEFT_MARGIN}${theme.subtle(cwd.padEnd(Math.max(width, cwd.length)))}`];
}
