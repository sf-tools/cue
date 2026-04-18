import { readdirSync } from 'node:fs';
import type { AgentStore } from '@/store';

export function currentMentionMatch(inputChars: string[], cursor: number) {
  const beforeCursor = inputChars.slice(0, cursor).join('');
  return beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
}

export function currentMentionQuery(inputChars: string[], cursor: number) {
  return currentMentionMatch(inputChars, cursor)?.[1] ?? null;
}

export function listMentionSuggestions(inputChars: string[], cursor: number, cwd = process.cwd()) {
  const query = currentMentionQuery(inputChars, cursor);
  if (query === null) return [];

  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => ({
        label: entry.isDirectory() ? `${entry.name}/` : entry.name,
        isDirectory: entry.isDirectory()
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.label.localeCompare(b.label);
      });

    const normalized = query.toLowerCase();
    return entries
      .filter(entry => entry.label.toLowerCase().includes(normalized))
      .slice(0, 6)
      .map(entry => entry.label);
  } catch {
    return [];
  }
}

export function acceptSuggestion(store: AgentStore, suggestions: string[]) {
  const state = store.getState();
  const suggestion = suggestions[state.selectedSuggestion];

  const match = currentMentionMatch(state.inputChars, state.cursor);
  if (!suggestion || !match) return false;

  const beforeCursor = state.inputChars.slice(0, state.cursor).join('');
  const afterCursor = state.inputChars.slice(state.cursor).join('');

  const fullMatch = match[0];
  const leadingWhitespace = fullMatch.startsWith(' ') ? ' ' : '';
  const replacement = `${leadingWhitespace}@${suggestion}${suggestion.endsWith('/') ? '' : ' '}`;
  const next = `${beforeCursor.slice(0, beforeCursor.length - fullMatch.length)}${replacement}${afterCursor}`;

  store.replaceInput(next, beforeCursor.length - fullMatch.length + replacement.length);
  return true;
}
