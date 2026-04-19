import type { AgentState } from './types';
import { createInitialMessages } from '@/config';

export const createInitialState = (): AgentState => ({
  messages: createInitialMessages(),
  inputChars: [],
  historyEntries: [],
  queuedSubmissions: [],
  cursor: 0,
  scrollOffset: 0,
  busy: false,
  busyStatusText: null,
  closed: false,
  liveAssistantText: '',
  selectedSuggestion: 0,
  lastPromptTokens: 0,
  totalCost: 0,
  abortController: null,
  abortConfirmationPending: false,
  abortRequested: false,
  exitConfirmationPending: false,
  pendingApproval: null,
  footerNotice: null,
  autoRunEnabled: false,
  autoCompactEnabled: true,
  commandApprovalSessionAllowed: false,
  editApprovalSessionAllowed: false,
  compacting: false
});
