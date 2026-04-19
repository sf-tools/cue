import { autoRunSlashCommand } from './auto-run';
import { compactSlashCommand } from './compact';
import { quitSlashCommand } from './exit';
import { logoutSlashCommand } from './logout';
import { modelSlashCommand } from './model';
import { planningSlashCommand } from './planning';
import { reasoningSlashCommand } from './reasoning';
import { reviewSlashCommand } from './review';
import { toggleAutoCompactSlashCommand } from './toggle-auto-compact';

export const builtinSlashCommands = [
  autoRunSlashCommand,
  compactSlashCommand,
  logoutSlashCommand,
  modelSlashCommand,
  planningSlashCommand,
  reasoningSlashCommand,
  reviewSlashCommand,
  toggleAutoCompactSlashCommand,
  quitSlashCommand
];
