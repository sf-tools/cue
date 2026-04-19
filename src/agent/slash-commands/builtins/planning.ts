import chalk from 'chalk';

import type { SlashCommand } from '../types';

const ARGUMENT_SUGGESTIONS = [
  {
    value: 'on',
    label: 'on',
    detail: 'Enable planning mode (read-only agent tools)',
    labelStyle: chalk.greenBright,
  },
  { value: 'off', label: 'off', detail: 'Disable planning mode', labelStyle: chalk.redBright },
  { value: 'toggle', label: 'toggle', detail: 'Toggle planning mode' },
  { value: 'status', label: 'status', detail: 'Show current planning mode status' },
] as const;

function parseMode(value: string | undefined) {
  if (!value) return 'toggle' as const;

  switch (value.toLowerCase()) {
    case 'on':
    case 'enable':
    case 'enabled':
    case 'true':
      return 'on' as const;
    case 'off':
    case 'disable':
    case 'disabled':
    case 'false':
      return 'off' as const;
    case 'toggle':
      return 'toggle' as const;
    case 'status':
      return 'status' as const;
    default:
      throw new Error(`invalid /planning mode: ${value}`);
  }
}

export const planningSlashCommand: SlashCommand = {
  name: 'plan',
  description: 'Agent stays read-only and focuses on options and plans.',
  argumentSuggestions: ARGUMENT_SUGGESTIONS,
  showArgumentSuggestionsOnExactInvocation: true,
  execute({ store, openCommandArgumentPicker, setPlanningMode, showFooterNotice }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);

    const requested = args.argv[0]?.toLowerCase();
    if (!requested && args.invocation === 'planning') {
      openCommandArgumentPicker('planning');
      return;
    }

    const mode = parseMode(requested);
    const current = store.getState().planningMode;
    const next = mode === 'status' ? current : mode === 'toggle' ? !current : mode === 'on';

    if (mode !== 'status') setPlanningMode(next);
    showFooterNotice(
      `Planning mode ${next ? 'enabled' : 'disabled'}${next ? ' · read-only tools' : ''}`,
    );
  },
};
