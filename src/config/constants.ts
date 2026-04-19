import { calcPrice } from '@pydantic/genai-prices';
import { BUILD_VERSION } from './version';

export const APP_NAME = 'Cue Control';
export const MODEL = 'gpt-5.4';

export const APP_VERSION = `v${BUILD_VERSION}`;
export const USER_SHELL = process.env.SHELL || '/bin/sh';

// TODO: dont fallback when no window. throw error instead
const MODEL_META = calcPrice({ input_tokens: 0, output_tokens: 0 }, MODEL, { providerId: 'openai' });
export const CONTEXT_WINDOW = MODEL_META?.model?.context_window ?? 1_000_000;

export const COMPACTION_TRIGGER_RATIO = 0.9;
export const COMPACTION_RECENT_MESSAGE_COUNT = 6;
export const COMPACTION_TRIGGER_TOKENS = Math.floor(CONTEXT_WINDOW * COMPACTION_TRIGGER_RATIO);
