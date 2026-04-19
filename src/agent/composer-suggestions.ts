import { acceptMentionSuggestion, currentMentionQuery, listMentionSuggestions, type MentionSuggestion } from './mentions';
import { acceptSlashCommandSuggestion, currentSlashCommandQuery, type SlashCommandRegistry, type SlashCommandSuggestion } from './slash-commands';
import type { AgentStore } from '@/store';

export type ComposerSuggestion = MentionSuggestion | SlashCommandSuggestion;

export function listComposerSuggestions(inputChars: string[], cursor: number, commands: SlashCommandRegistry): ComposerSuggestion[] {
  const slashQuery = currentSlashCommandQuery(inputChars, cursor);
  if (slashQuery !== null) return commands.listSuggestions(slashQuery);

  if (currentMentionQuery(inputChars, cursor) !== null) return listMentionSuggestions(inputChars, cursor);
  return [];
}

export function acceptComposerSuggestion(store: AgentStore, suggestions: ComposerSuggestion[]) {
  const suggestion = suggestions[store.getState().selectedSuggestion];
  if (!suggestion) return false;

  if (suggestion.kind === 'slash-command') return acceptSlashCommandSuggestion(store, suggestion);
  return acceptMentionSuggestion(store, suggestion);
}
