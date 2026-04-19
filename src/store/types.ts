import type { ModelMessage } from 'ai';
import type { ApprovalRequest, HistoryEntry } from '@/types';

export type AgentState = {
  messages: ModelMessage[];
  inputChars: string[];
  historyEntries: HistoryEntry[];
  queuedSubmissions: string[];
  cursor: number;
  scrollOffset: number;
  busy: boolean;
  busyStatusText: string | null;
  closed: boolean;
  liveAssistantText: string;
  selectedSuggestion: number;
  lastPromptTokens: number;
  totalCost: number;
  abortController: AbortController | null;
  abortConfirmationPending: boolean;
  abortRequested: boolean;
  exitConfirmationPending: boolean;
  pendingApproval: ApprovalRequest | null;
  autoRunEnabled: boolean;
  autoCompactEnabled: boolean;
  commandApprovalSessionAllowed: boolean;
  editApprovalSessionAllowed: boolean;
  compacting: boolean;
};
