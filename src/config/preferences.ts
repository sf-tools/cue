import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_MODEL, getSupportedThinkingModes, normalizeOpenAIModelId, type ThinkingMode } from './models';

export type CuePreferences = {
  model: string;
  reasoning: ThinkingMode;
  autoCompactEnabled: boolean;
};

export const CUE_PREFERENCES_PATH = join(homedir(), '.cue', 'model.json');

export function defaultCuePreferences(): CuePreferences {
  return {
    model: DEFAULT_MODEL,
    reasoning: 'auto',
    autoCompactEnabled: true
  };
}

function isThinkingMode(value: unknown): value is ThinkingMode {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high';
}

export function normalizeCuePreferences(value: unknown): CuePreferences {
  const defaults = defaultCuePreferences();
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const model = normalizeOpenAIModelId(typeof candidate.model === 'string' ? candidate.model : defaults.model);
  const requestedReasoning = isThinkingMode(candidate.reasoning) ? candidate.reasoning : defaults.reasoning;
  const supportedModes = getSupportedThinkingModes(model);

  return {
    model,
    reasoning: supportedModes.includes(requestedReasoning) ? requestedReasoning : (supportedModes[0] ?? 'auto'),
    autoCompactEnabled: typeof candidate.autoCompactEnabled === 'boolean' ? candidate.autoCompactEnabled : defaults.autoCompactEnabled
  };
}

export async function loadCuePreferences(path = CUE_PREFERENCES_PATH): Promise<CuePreferences> {
  try {
    const raw = await readFile(path, 'utf8');
    return normalizeCuePreferences(JSON.parse(raw));
  } catch {
    return defaultCuePreferences();
  }
}

export async function saveCuePreferences(preferences: CuePreferences, path = CUE_PREFERENCES_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalizeCuePreferences(preferences), null, 2)}\n`, 'utf8');
}
