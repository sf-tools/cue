import { autoRunSlashCommand } from './auto-run';
import { compactSlashCommand } from './compact';
import { quitSlashCommand } from './exit';
import { modelSlashCommand } from './model';
import { reasoningSlashCommand } from './reasoning';
import { toggleAutoCompactSlashCommand } from './toggle-auto-compact';

export const builtinSlashCommands = [
  autoRunSlashCommand,
  compactSlashCommand,
  modelSlashCommand,
  reasoningSlashCommand,
  toggleAutoCompactSlashCommand,
  quitSlashCommand
];
