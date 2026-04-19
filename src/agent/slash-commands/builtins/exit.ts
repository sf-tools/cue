import type { SlashCommand } from '../types';

export const quitSlashCommand: SlashCommand = {
  name: 'quit',
  specialHiddenAliases: ['exit'],
  description: 'Exit Cue',
  execute({ cleanup }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);
    cleanup(0);
  },
};
