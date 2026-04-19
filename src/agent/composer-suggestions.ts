import chalk from 'chalk';

import { acceptMentionSuggestion, currentMentionQuery, listMentionSuggestions, type MentionSuggestion } from './mentions';
import { acceptSlashCommandSuggestion, currentSlashCommandQuery, type SlashCommandRegistry, type SlashCommandSuggestion } from './slash-commands';
import type { AgentStore } from '@/store';

export type ComposerSuggestion = MentionSuggestion | SlashCommandSuggestion;

function markSelectedSuggestions(suggestions: SlashCommandSuggestion[], options: { currentModel: string; thinkingMode: string }) {
  const marked = suggestions.map(suggestion => {
    if (suggestion.commandName === 'model' && suggestion.replacement === `/model ${options.currentModel}`) {
      return {
        ...suggestion,
        suffix: `${suggestion.suffix ?? ''} ✓`,
        suffixStyle: chalk.green
      };
    }

    if (suggestion.commandName === 'reasoning' && suggestion.replacement === `/reasoning ${options.thinkingMode}`) {
      return {
        ...suggestion,
        suffix: `${suggestion.suffix ?? ''} ✓`,
        suffixStyle: chalk.green
      };
    }

    return suggestion;
  });

  const currentModelIndex = marked.findIndex(
    suggestion => suggestion.commandName === 'model' && suggestion.replacement === `/model ${options.currentModel}`
  );

  if (currentModelIndex > 0) {
    const [currentModelSuggestion] = marked.splice(currentModelIndex, 1);
    marked.unshift(currentModelSuggestion);
  }

  return marked;
}

export function listComposerSuggestions(
  inputChars: string[],
  cursor: number,
  commands: SlashCommandRegistry,
  options: { currentModel: string; thinkingMode: string }
): ComposerSuggestion[] {
  const slashQuery = currentSlashCommandQuery(inputChars, cursor);
  if (slashQuery !== null) return markSelectedSuggestions(commands.listSuggestions(slashQuery), options);

  if (currentMentionQuery(inputChars, cursor) !== null) return listMentionSuggestions(inputChars, cursor);
  return [];
}

export function acceptComposerSuggestion(store: AgentStore, suggestions: ComposerSuggestion[]) {
  const suggestion = suggestions[store.getState().selectedSuggestion];
  if (!suggestion) return false;

  if (suggestion.kind === 'slash-command') return acceptSlashCommandSuggestion(store, suggestion);
  return acceptMentionSuggestion(store, suggestion);
}
