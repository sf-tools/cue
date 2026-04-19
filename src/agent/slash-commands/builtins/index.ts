import { autoRunSlashCommand } from './auto-run';
import { compactSlashCommand } from './compact';
import { quitSlashCommand } from './exit';
import { logoutSlashCommand } from './logout';
import { modelSlashCommand } from './model';
import { planningSlashCommand } from './planning';
import { privateSlashCommand } from './private';
import { reasoningSlashCommand } from './reasoning';
import { reviewSlashCommand } from './review';
import { shareSlashCommand } from './share';
import { toggleAutoCompactSlashCommand } from './toggle-auto-compact';
import { toolsSlashCommand } from './tools';

export const builtinSlashCommands = [
  autoRunSlashCommand,
  compactSlashCommand,
  logoutSlashCommand,
  modelSlashCommand,
  planningSlashCommand,
  privateSlashCommand,
  reasoningSlashCommand,
  reviewSlashCommand,
  shareSlashCommand,
  toggleAutoCompactSlashCommand,
  toolsSlashCommand,
  quitSlashCommand,
];
