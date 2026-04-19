import { tool } from 'ai';
import { z } from 'zod';

import type { ToolFactoryOptions } from './types';

const choiceOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().optional()
});

export function createChoiceSelectorTool({ requestChoice }: ToolFactoryOptions) {
  return tool({
    description:
      'Ask the user to choose between concrete options before proceeding. Use this when a plan depends on a product or architecture decision and the user should pick the direction first.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Short question title shown to the user.'),
      detail: z.string().min(1).describe('Brief context explaining what the choice affects.'),
      options: z.array(choiceOptionSchema).min(2).max(9).describe('Distinct options the user can choose from.'),
      recommendedValue: z.string().optional().describe('Optional recommended option value.')
    }),
    execute: async ({ title, detail, options, recommendedValue }) => {
      const seen = new Set<string>();
      const normalizedOptions = options.filter(option => {
        const value = option.value.trim();
        if (!value || seen.has(value)) return false;
        seen.add(value);
        return true;
      });

      if (normalizedOptions.length < 2) throw new Error('choice_selector requires at least two distinct options');

      const recommended = normalizedOptions.some(option => option.value === recommendedValue) ? recommendedValue : undefined;
      const selection = await requestChoice({
        title: title.trim(),
        detail: detail.trim(),
        options: normalizedOptions,
        recommendedValue: recommended
      });

      return {
        value: selection.value,
        label: selection.label,
        detail: selection.detail,
        index: selection.index
      };
    }
  });
}
