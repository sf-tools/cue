import type { SlashCommand } from '../types';

function buildCommitPrompt(messageHint?: string) {
  return [
    'Stage and commit the current changes.',
    'Inspect the diff first, then create a concise commit message and run the necessary git commands.',
    'Do not push any branches or tags.',
    messageHint?.trim() ? `Message hint: ${messageHint.trim()}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export const commitSlashCommand: SlashCommand = {
  name: 'commit',
  description: 'Ask the agent to stage and commit the current changes.',
  suggestedInput: '[message hint]',
  execute({ enqueueSubmission, showFooterNotice }, args) {
    enqueueSubmission(buildCommitPrompt(args.argsText));
    showFooterNotice('Queued commit task');
  },
};
