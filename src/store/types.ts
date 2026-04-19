import type { ModelMessage } from 'ai';
import type { ThinkingMode } from '@/config';
import type { ApprovalRequest, HistoryEntry } from '@/types';

export type ComposerPasteRange = {
  start: number;
  end: number;
};

export type AgentState = {
  messages: ModelMessage[];
  inputChars: string[];
  pasteRanges: ComposerPasteRange[];
  historyEntries: HistoryEntry[];
  queuedSubmissions: string[];
  cursor: number;
  scrollOffset: number;
  busy: boolean;
  busyStatusText: string | null;
  closed: boolean;
  liveAssistantText: string;
  liveReasoningText: string;
  selectedSuggestion: number;
  currentModel: string;
  thinkingMode: ThinkingMode;
  lastPromptTokens: number;
  lastOutputTokens: number;
  lastReasoningTokens: number;
  totalCost: number;
  abortController: AbortController | null;
  abortConfirmationPending: boolean;
  abortRequested: boolean;
  steerRequested: boolean;
  exitConfirmationPending: boolean;
  pendingApproval: ApprovalRequest | null;
  footerNotice: string | null;
  autoRunEnabled: boolean;
  autoCompactEnabled: boolean;
  commandApprovalSessionAllowed: boolean;
  editApprovalSessionAllowed: boolean;
  compacting: boolean;
};
