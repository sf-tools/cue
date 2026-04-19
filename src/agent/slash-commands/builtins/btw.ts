import { EntryKind } from '@/types';
import type { SlashCommand } from '../types';

export const btwSlashCommand: SlashCommand = {
  name: 'btw',
  description: 'Ask a side question without affecting the main chat context.',
  suggestedInput: '<question>',
  async execute({ printEntries, runSidePrompt, showFooterNotice }, args) {
    const question = args.argsText.trim();
    if (!question) throw new Error(`/${args.invocation} requires a question`);

    const text = await runSidePrompt(question);
    printEntries([
      { type: 'entry', kind: EntryKind.Meta, text: `(btw) ${question}` },
      { type: 'entry', kind: EntryKind.Assistant, text },
    ]);
    showFooterNotice('Side answer ready · main chat unchanged');
  },
};
