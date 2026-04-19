import { autoRunSlashCommand } from './auto-run';
import { compactSlashCommand } from './compact';
import { quitSlashCommand } from './exit';
import { toggleAutoCompactSlashCommand } from './toggle-auto-compact';

export const builtinSlashCommands = [autoRunSlashCommand, compactSlashCommand, toggleAutoCompactSlashCommand, quitSlashCommand];
