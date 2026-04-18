import type { ModelMessage } from 'ai';
import type { HistoryEntry } from '@/types';

export type AgentState = {
  messages: ModelMessage[];
  inputChars: string[];
  historyEntries: HistoryEntry[];
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
