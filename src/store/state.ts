import type { AgentState } from './types';
import { createInitialMessages } from '@/config';

export const createInitialState = (): AgentState => ({
  messages: createInitialMessages(),
  inputChars: [],
  historyBlocks: [],
  cursor: 0,
  scrollOffset: 0,
  busy: false,
  closed: false,
  liveAssistantText: '',
  selectedSuggestion: 0,
  lastPromptTokens: 0,
  totalCost: 0,
  abortController: null
});
