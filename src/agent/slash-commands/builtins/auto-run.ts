import type { SlashCommand } from '../types';

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
    case 'status':
      return 'status' as const;
    default:
      throw new Error(`invalid /auto-run mode: ${value}`);
  }
}

export const autoRunSlashCommand: SlashCommand = {
  name: 'auto-run',
  specialHiddenAliases: ['autorun'],
  description: 'Skip approval prompts for commands and edits',
  execute({ store, render }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);

    const mode = parseMode(args.argv[0]);
    const current = store.getState().autoRunEnabled;
    const next = mode === 'status' ? current : mode === 'toggle' ? !current : mode === 'on';

    if (mode !== 'status') store.setAutoRunEnabled(next);

    render();
  },
};
