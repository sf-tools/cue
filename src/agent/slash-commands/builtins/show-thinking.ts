import type { SlashCommand } from '../types';
import { parseToggleMode, resolveToggleMode } from './toggle-mode';

const ARGUMENT_SUGGESTIONS = [
  { value: 'on', detail: 'Show reasoning blocks in the transcript' },
  { value: 'off', detail: 'Hide reasoning blocks in the transcript' },
  { value: 'toggle', detail: 'Toggle reasoning block display' },
  { value: 'status', detail: 'Show current reasoning display status' },
] as const;

export const showThinkingSlashCommand: SlashCommand = {
  name: 'show-thinking',
  specialHiddenAliases: ['showthinking'],
  description: 'Toggle reasoning block display in the transcript.',
  argumentSuggestions: ARGUMENT_SUGGESTIONS,
  showArgumentSuggestionsOnExactInvocation: true,
  execute({ store, setShowThinking, showFooterNotice }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);

    const mode = parseToggleMode(args.argv[0], args.invocation);
    const current = store.getState().showThinking;
    const next = resolveToggleMode(mode, current);

    if (mode !== 'status') setShowThinking(next);
    showFooterNotice(`Thinking blocks ${next ? 'shown' : 'hidden'}`);
  },
};
