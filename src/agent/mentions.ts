import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import Fuse from 'fuse.js';
import type { AgentStore } from '@/store';

function currentMentionMatch(inputChars: string[], cursor: number) {
  const beforeCursor = inputChars.slice(0, cursor).join('');
  return beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
}

function splitMentionQuery(query: string, cwd: string) {
  if (query && !query.endsWith('/')) {
    try {
      if (statSync(resolve(cwd, query)).isDirectory()) return { directory: `${query}/`, fragment: '' };
    } catch {}
  }

  const slashIndex = query.lastIndexOf('/');
  if (slashIndex === -1) return { directory: '', fragment: query };

  return {
    directory: query.slice(0, slashIndex + 1),
    fragment: query.slice(slashIndex + 1)
  };
}

type MentionEntry = {
  label: string;
  name: string;
  isDirectory: boolean;
};

function listDirectoryEntries(cwd: string, directory: string) {
  return readdirSync(resolve(cwd, directory || '.'), { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.'))
    .map<MentionEntry>(entry => ({
      label: `${directory}${entry.name}${entry.isDirectory() ? '/' : ''}`,
      name: entry.name,
      isDirectory: entry.isDirectory()
    }));
}

function compareDirectoryEntries(a: MentionEntry, b: MentionEntry) {
  return a.label.localeCompare(b.label);
}

function fuzzyFilterEntries(entries: MentionEntry[], fragment: string) {
  if (!fragment) return entries.sort(compareDirectoryEntries);

  const fuse = new Fuse(entries, {
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.4,
    keys: [
      { name: 'name', weight: 0.8 },
      { name: 'label', weight: 0.2 }
    ]
  });

  return fuse
    .search(fragment)
    .sort((a, b) => {
      const scoreDiff = (a.score ?? 0) - (b.score ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return compareDirectoryEntries(a.item, b.item);
    })
    .map(result => result.item);
}

export function currentMentionQuery(inputChars: string[], cursor: number) {
  return currentMentionMatch(inputChars, cursor)?.[1] ?? null;
}

export function listMentionSuggestions(inputChars: string[], cursor: number, cwd = process.cwd()) {
  const query = currentMentionQuery(inputChars, cursor);
  if (query === null) return [];

  const { directory, fragment } = splitMentionQuery(query, cwd);

  try {
    return fuzzyFilterEntries(listDirectoryEntries(cwd, directory), fragment)
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
