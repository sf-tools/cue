import { calcPrice } from '@pydantic/genai-prices';
import type { LanguageModelUsage } from 'ai';

export const DEFAULT_MODEL = 'gpt-5.4';
export type ThinkingMode = 'auto' | 'low' | 'medium' | 'high';

export type OpenAIModelOption = {
  id: string;
  label: string;
  description: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export const OPENAI_MODEL_OPTIONS: OpenAIModelOption[] = [
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Flagship model for the hardest coding and agent tasks',
    contextWindow: 1_050_000,
    reasoning: true
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    description: 'Faster, cheaper GPT-5.4 for everyday coding work',
    contextWindow: 400_000,
    reasoning: true
  },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', description: 'Smallest GPT-5.4 variant for speed and cost', contextWindow: 400_000, reasoning: true },
  { id: 'gpt-5.2', label: 'GPT-5.2', description: 'Balanced GPT-5 generation with strong reasoning', contextWindow: 400_000, reasoning: true },
  { id: 'gpt-5.1', label: 'GPT-5.1', description: 'Earlier GPT-5 release with broad reasoning support', contextWindow: 400_000, reasoning: true },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'GPT-5.1 tuned toward code-heavy workflows', contextWindow: 400_000, reasoning: true },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini',
    description: 'Faster lower-cost Codex-style GPT-5.1',
    contextWindow: 400_000,
    reasoning: true
  },
  {
    id: 'gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max',
    description: 'Highest-effort GPT-5.1 Codex-style coding model',
    contextWindow: 400_000,
    reasoning: true
  },
  { id: 'gpt-5', label: 'GPT-5', description: 'General GPT-5 frontier model', contextWindow: 400_000, reasoning: true },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', description: 'Smaller GPT-5 tuned for speed and cost', contextWindow: 400_000, reasoning: true },
  { id: 'gpt-5-nano', label: 'GPT-5 nano', description: 'Tiny GPT-5 for lightweight quick tasks', contextWindow: 400_000, reasoning: true },
  { id: 'gpt-4.1', label: 'GPT-4.1', description: 'Reliable general model with a huge context window', contextWindow: 1_000_000 },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Fast low-cost GPT-4.1 for common work', contextWindow: 1_000_000 },
  { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano', description: 'Smallest GPT-4.1 variant', contextWindow: 1_000_000 },
  { id: 'gpt-4o', label: 'GPT-4o', description: 'Realtime-friendly all-rounder', contextWindow: 128_000 },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Cheap fast GPT-4o for lighter tasks', contextWindow: 128_000 },
  { id: 'o1', label: 'o1', description: 'Deliberate reasoning model for harder problems', contextWindow: 128_000, reasoning: true },
  { id: 'o1-mini', label: 'o1 mini', description: 'Cheaper smaller o1 reasoning model', contextWindow: 128_000, reasoning: true },
  { id: 'o1-pro', label: 'o1 pro', description: 'Higher-end o1 for deeper reasoning', contextWindow: 200_000, reasoning: true },
  { id: 'o3', label: 'o3', description: 'Top-end reasoning model for hard analysis and coding', contextWindow: 200_000, reasoning: true },
  { id: 'o3-mini', label: 'o3 mini', description: 'Cheaper STEM and coding-focused reasoning model', contextWindow: 200_000, reasoning: true },
  {
    id: 'o4-mini',
    label: 'o4 mini',
    description: 'Fast reasoning model popular for coding and agent loops',
    contextWindow: 200_000,
    reasoning: true
  },
  {
    id: 'codex-mini-latest',
    label: 'Codex Mini (latest)',
    description: 'Codex CLI tuned o4-mini; great default for agentic coding',
    contextWindow: 200_000,
    reasoning: true
  },
  { id: 'codex-mini', label: 'Codex Mini', description: 'Stable Codex Mini alias for coding-focused work', contextWindow: 200_000, reasoning: true }
];

const MODEL_OPTION_MAP = new Map(OPENAI_MODEL_OPTIONS.map(option => [option.id.toLowerCase(), option]));

function normalizedModelId(model: string) {
  return model.trim().toLowerCase();
}

function inferContextWindow(model: string) {
  const normalized = normalizedModelId(model);

  if (normalized.startsWith('gpt-5.4') && !normalized.includes('mini') && !normalized.includes('nano')) return 1_050_000;
  if (normalized.startsWith('gpt-5')) return 400_000;
  if (normalized.startsWith('gpt-4.1')) return 1_000_000;
  if (normalized.startsWith('gpt-4o')) return 128_000;
  if (normalized.startsWith('o1')) return 128_000;
  if (normalized.startsWith('o3') || normalized.startsWith('o4') || normalized.includes('codex')) return 200_000;

  return null;
}

export function normalizeOpenAIModelId(model: string) {
  return model.trim().toLowerCase();
}

export function getKnownOpenAIModel(model: string) {
  return MODEL_OPTION_MAP.get(normalizedModelId(model));
}

export function getOpenAIModelDisplayName(model: string) {
  const meta = calcPrice({ input_tokens: 0, output_tokens: 0 }, model, { providerId: 'openai' });
  return meta?.model?.name ?? getKnownOpenAIModel(model)?.label ?? model;
}

export function getOpenAIContextWindow(model: string) {
  const meta = calcPrice({ input_tokens: 0, output_tokens: 0 }, model, { providerId: 'openai' });
  return meta?.model?.context_window ?? getKnownOpenAIModel(model)?.contextWindow ?? inferContextWindow(model);
}

export function isReasoningCapableOpenAIModel(model: string) {
  const normalized = normalizedModelId(model);
  const known = getKnownOpenAIModel(normalized);
  if (known?.reasoning) return true;

  return normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4') || normalized.startsWith('gpt-5');
}

export function getSupportedThinkingModes(model: string): ThinkingMode[] {
  return isReasoningCapableOpenAIModel(model) ? ['auto', 'low', 'medium', 'high'] : ['auto'];
}

export function cycleThinkingMode(current: ThinkingMode, model: string) {
  const supportedModes = getSupportedThinkingModes(model);
  const index = supportedModes.indexOf(current);
  return supportedModes[(index + 1 + supportedModes.length) % supportedModes.length] ?? supportedModes[0];
}

export function createOpenAIProviderOptions(model: string, thinkingMode: ThinkingMode, options: { includeReasoningSummary?: boolean } = {}) {
  if (!isReasoningCapableOpenAIModel(model)) return undefined;

  const openai: { reasoningEffort?: Exclude<ThinkingMode, 'auto'>; reasoningSummary?: 'auto' } = {};

  if (thinkingMode !== 'auto') openai.reasoningEffort = thinkingMode;
  if (options.includeReasoningSummary !== false) openai.reasoningSummary = 'auto';

  return { openai };
}

export function pricingUsageFromLanguageModelUsage(usage: LanguageModelUsage) {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_tokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    cache_write_tokens: usage.inputTokenDetails.cacheWriteTokens ?? 0
  };
}

export function formatThinkingMode(thinkingMode: ThinkingMode) {
  return thinkingMode;
}

export function getThinkingModeDescription(thinkingMode: ThinkingMode) {
  switch (thinkingMode) {
    case 'auto':
      return 'Let the model choose the effort level';
    case 'low':
      return 'Fastest reasoning with the lowest cost';
    case 'medium':
      return 'Balanced speed, depth, and cost';
    case 'high':
      return 'Deepest reasoning with higher latency and cost';
  }
}
