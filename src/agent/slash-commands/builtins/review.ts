import { buildCodebaseReviewPrompt } from '@/review';
import type { SlashCommand } from '../types';

export const reviewSlashCommand: SlashCommand = {
  name: 'review',
  description: 'Run a read-only review of the current codebase.',
  suggestedInput: '<question>',
  execute({ enqueueSubmission, showFooterNotice }, args) {
    const focus = args.argsText.trim();

    enqueueSubmission(buildCodebaseReviewPrompt(focus), { planningMode: true });
    showFooterNotice(focus ? `Queued codebase review · focus: ${focus}` : 'Queued codebase review');
  }
};
