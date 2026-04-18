import type { ModelMessage } from 'ai';

export type AgentState = {
  messages: ModelMessage[];
  inputChars: string[];
  historyBlocks: string[][];
  cursor: number;
  scrollOffset: number;
  busy: boolean;
  closed: boolean;
  liveAssistantText: string;
  selectedSuggestion: number;
  lastPromptTokens: number;
  totalCost: number;
  abortController: AbortController | null;
};
