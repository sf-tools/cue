import { BUILD_VERSION } from './version';
import { DEFAULT_MODEL, getOpenAIContextWindow } from './models';

export const APP_NAME = 'Cue Control';
export const MODEL = DEFAULT_MODEL;

export const APP_VERSION = `v${BUILD_VERSION}`;
export const USER_SHELL = process.env.SHELL || '/bin/sh';

// TODO: dont fallback when no window. throw error instead
export const CONTEXT_WINDOW = getOpenAIContextWindow(MODEL) ?? 1_000_000;

export const COMPACTION_TRIGGER_RATIO = 0.9;
export const COMPACTION_RECENT_MESSAGE_COUNT = 6;
export const COMPACTION_TRIGGER_TOKENS = Math.floor(CONTEXT_WINDOW * COMPACTION_TRIGGER_RATIO);

export function getContextWindow(model: string) {
  return getOpenAIContextWindow(model) ?? CONTEXT_WINDOW;
}

export function getCompactionTriggerTokens(model: string) {
  return Math.floor(getContextWindow(model) * COMPACTION_TRIGGER_RATIO);
}
