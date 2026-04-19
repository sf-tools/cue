import type { SlashCommand } from '../types';

export const copyRequestIdSlashCommand: SlashCommand = {
  name: 'copy-request-id',
  description: 'Copy the last model request ID to the clipboard.',
  async execute({ copyToClipboard, getLastRequestId, showFooterNotice }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const requestId = getLastRequestId();
    if (!requestId) throw new Error('no request ID is available yet');

    await copyToClipboard(requestId);
    showFooterNotice('Request ID copied');
  },
};
