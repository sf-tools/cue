import { EntryKind } from '@/types';
import type { SlashCommand } from '../types';

export const toggleAutoCompactSlashCommand: SlashCommand = {
  name: 'toggle-auto-compact',
  specialHiddenAliases: ['toggleautocompact'],
  description: 'Toggle automatic conversation compaction',
  execute({ store, persistEntry }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const next = !store.getState().autoCompactEnabled;
    store.setAutoCompactEnabled(next);
    persistEntry(EntryKind.Meta, `auto compact ${next ? 'enabled' : 'disabled'}`);
  }
};
