import { buildCodebaseReviewPrompt } from '@/review';
import type { SlashCommand } from '../types';

const SIMPLIFY_FOCUS =
  'low-information comments, one-off helpers, unnecessary complexity, obvious performance issues, and reuse opportunities; prioritize the highest-leverage simplifications with exact file references';

export const simplifySlashCommand: SlashCommand = {
  name: 'simplify',
  description: 'Run a read-only simplification review across the codebase.',
  execute({ enqueueSubmission, showFooterNotice }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    enqueueSubmission(buildCodebaseReviewPrompt(SIMPLIFY_FOCUS), { planningMode: true });
    showFooterNotice('Queued simplification review');
  },
};
