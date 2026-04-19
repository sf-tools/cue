import type { SlashCommand } from '../types';
import { parseToggleMode, resolveToggleMode } from './toggle-mode';

const ARGUMENT_SUGGESTIONS = [
  { value: 'on', detail: 'Enable ask mode (read-only Q&A)' },
  { value: 'off', detail: 'Disable ask mode' },
  { value: 'toggle', detail: 'Toggle ask mode' },
  { value: 'status', detail: 'Show current ask mode status' },
] as const;

export const askSlashCommand: SlashCommand = {
  name: 'ask',
  description: 'Toggle ask mode (read-only Q&A; no edits or mutating commands).',
  argumentSuggestions: ARGUMENT_SUGGESTIONS,
  showArgumentSuggestionsOnExactInvocation: true,
  execute({ store, setPlanningMode, showFooterNotice }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);

    const mode = parseToggleMode(args.argv[0], args.invocation);
    const current = store.getState().planningMode;
    const next = resolveToggleMode(mode, current);

    if (mode !== 'status') setPlanningMode(next);
    showFooterNotice(`Ask mode ${next ? 'enabled' : 'disabled'}${next ? ' · read-only' : ''}`);
  },
};
