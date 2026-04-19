import { aboutSlashCommand } from './about';
import { askSlashCommand } from './ask';
import { autoRunSlashCommand } from './auto-run';
import { btwSlashCommand } from './btw';
import { commitSlashCommand } from './commit';
import { compactSlashCommand } from './compact';
import { copyConversationIdSlashCommand } from './copy-conversation-id';
import { copyRequestIdSlashCommand } from './copy-request-id';
import { quitSlashCommand } from './exit';
import { imgSlashCommand } from './img';
import { logoutSlashCommand } from './logout';
import { modelSlashCommand } from './model';
import { planningSlashCommand } from './planning';
import { privateSlashCommand } from './private';
import { reasoningSlashCommand } from './reasoning';
import { renameSlashCommand } from './rename';
import { reviewSlashCommand } from './review';
import { shareSlashCommand } from './share';
import { shellSlashCommand } from './shell';
import { showThinkingSlashCommand } from './show-thinking';
import { simplifySlashCommand } from './simplify';
import { switchSlashCommand } from './switch';
import { toggleAutoCompactSlashCommand } from './toggle-auto-compact';
import { toolsSlashCommand } from './tools';

export const builtinSlashCommands = [
  aboutSlashCommand,
  askSlashCommand,
  autoRunSlashCommand,
  btwSlashCommand,
  commitSlashCommand,
  compactSlashCommand,
  copyConversationIdSlashCommand,
  copyRequestIdSlashCommand,
  imgSlashCommand,
  logoutSlashCommand,
  modelSlashCommand,
  planningSlashCommand,
  privateSlashCommand,
  reasoningSlashCommand,
  renameSlashCommand,
  reviewSlashCommand,
  shareSlashCommand,
  shellSlashCommand,
  showThinkingSlashCommand,
  simplifySlashCommand,
  switchSlashCommand,
  toggleAutoCompactSlashCommand,
  toolsSlashCommand,
  quitSlashCommand,
];
