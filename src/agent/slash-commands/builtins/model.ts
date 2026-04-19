import approx from 'approximate-number';

import { EntryKind } from '@/types';
import { OPENAI_MODEL_OPTIONS, getOpenAIModelDisplayName, normalizeOpenAIModelId } from '@/config';
import type { SlashCommand } from '../types';

function findModel(value: string) {
  const normalized = normalizeOpenAIModelId(value);
  return OPENAI_MODEL_OPTIONS.find(option => option.id === normalized);
}

function formatContextWindow(contextWindow?: number) {
  return contextWindow ? `${approx(contextWindow, { capital: false, precision: 2 })} ctx` : 'context unknown';
}

const MODEL_ARGUMENT_SUGGESTIONS = OPENAI_MODEL_OPTIONS.map(option => ({
  value: option.id,
  label: option.label,
  detail: `${option.description} · ${formatContextWindow(option.contextWindow)}`
}));

export const modelSlashCommand: SlashCommand = {
  name: 'model',
  description: 'Switch the active OpenAI model.',
  suggestedInput: OPENAI_MODEL_OPTIONS[0]?.id,
  argumentSuggestions: MODEL_ARGUMENT_SUGGESTIONS,
  showArgumentSuggestionsOnExactInvocation: true,
  execute({ openCommandArgumentPicker, setCurrentModel, persistEntry }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);

    const requested = args.argv[0];
    if (!requested) {
      openCommandArgumentPicker('model');
      return;
    }

    const model = findModel(requested);
    if (!model) throw new Error(`unknown /${args.invocation} model: ${requested}`);

    setCurrentModel(model.id);
    persistEntry(EntryKind.Meta, `model set to ${getOpenAIModelDisplayName(model.id)}`);
  }
};
