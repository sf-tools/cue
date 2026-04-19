import type { SlashCommand } from '../types';

export const shellSlashCommand: SlashCommand = {
  name: 'shell',
  description: 'Enter shell mode, or run a shell command immediately.',
  suggestedInput: '[command]',
  execute({ enqueueSubmission, insertText, showFooterNotice }, args) {
    const command = args.argsText.trim();

    if (!command) {
      insertText('!');
      showFooterNotice('Shell mode · type a command and press Enter');
      return;
    }

    enqueueSubmission(`!${command}`);
    showFooterNotice(`Queued shell command · ${command}`);
  },
};
