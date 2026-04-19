import type { SlashCommand } from '../types';

export const copyConversationIdSlashCommand: SlashCommand = {
  name: 'copy-conversation-id',
  specialHiddenAliases: ['copy-session-id'],
  description: 'Copy the current conversation ID to the clipboard.',
  async execute({ copyToClipboard, getSessionId, showFooterNotice }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    await copyToClipboard(getSessionId());
    showFooterNotice('Conversation ID copied');
  },
};
