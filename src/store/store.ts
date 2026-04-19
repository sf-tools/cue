import { createInitialState } from './state';

import type { ModelMessage } from 'ai';
import type { ApprovalRequest, ApprovalScope, HistoryEntry } from '@/types';
import type { AgentState } from './types';

export type AgentStore = ReturnType<typeof createAgentStore>;

function hasVisibleContent(entry: HistoryEntry) {
  if (entry.type === 'tool') return true;
  if (entry.type === 'plain' || entry.type === 'ansi') return entry.text.trim().length > 0;
  return entry.text.trim().length > 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

export function createAgentStore(initialState: AgentState = createInitialState()) {
  const state = initialState;

  return {
    getState() {
      return state;
    },

    update(updater: (state: AgentState) => void) {
      updater(state);
      return state;
    },

    setClosed(closed = true) {
      state.closed = closed;
      return state;
    },

    setBusy(busy: boolean) {
      state.busy = busy;
      if (!busy) state.busyStatusText = null;
      return state;
    },

    setBusyStatusText(busyStatusText: string | null) {
      state.busyStatusText = busyStatusText;
      return state;
    },

    resetComposer() {
      state.inputChars.length = 0;
      state.cursor = 0;
      state.scrollOffset = 0;
      return state;
    },

    setAbortController(abortController: AbortController | null) {
      state.abortController = abortController;
      if (abortController === null) {
        state.abortConfirmationPending = false;
        state.abortRequested = false;
      }
      return state;
    },

    setAbortConfirmationPending(abortConfirmationPending: boolean) {
      state.abortConfirmationPending = abortConfirmationPending;
      return state;
    },

    setAbortRequested(abortRequested: boolean) {
      state.abortRequested = abortRequested;
      return state;
    },

    setExitConfirmationPending(exitConfirmationPending: boolean) {
      state.exitConfirmationPending = exitConfirmationPending;
      return state;
    },

    setPendingApproval(pendingApproval: ApprovalRequest | null) {
      state.pendingApproval = pendingApproval;
      return state;
    },

    setAutoRunEnabled(autoRunEnabled: boolean) {
      state.autoRunEnabled = autoRunEnabled;
      return state;
    },

    setApprovalSessionAllowed(scope: ApprovalScope, allowed: boolean) {
      if (scope === 'command') state.commandApprovalSessionAllowed = allowed;
      else state.editApprovalSessionAllowed = allowed;
      return state;
    },

    setLiveAssistantText(text: string) {
      state.liveAssistantText = text;
      return state;
    },

    appendLiveAssistantText(chunk: string) {
      state.liveAssistantText += chunk;
      return state;
    },

    clearLiveAssistantText() {
      state.liveAssistantText = '';
      return state;
    },

    pushMessage(message: ModelMessage) {
      state.messages.push(message);
      return state;
    },

    pushMessages(messages: ModelMessage[]) {
      state.messages.push(...messages);
      return state;
    },

    pushHistoryEntry(entry: HistoryEntry) {
      if (hasVisibleContent(entry)) state.historyEntries.push(entry);
      return state;
    },

    updateLastHistoryEntry(updater: (entry: HistoryEntry) => HistoryEntry | null) {
      const index = state.historyEntries.length - 1;
      if (index < 0) return state;

      const nextEntry = updater(state.historyEntries[index]);
      if (nextEntry) state.historyEntries[index] = nextEntry;
      return state;
    },

    enqueueSubmission(text: string) {
      state.queuedSubmissions.push(text);
      return state;
    },

    shiftQueuedSubmission() {
      return state.queuedSubmissions.shift();
    },

    upsertToolEntry(entry: Extract<HistoryEntry, { type: 'tool' }>) {
      const index = state.historyEntries.findIndex(candidate => candidate.type === 'tool' && candidate.toolCallId === entry.toolCallId);

      if (index === -1) state.historyEntries.push(entry);
      else state.historyEntries[index] = entry;

      return state;
    },

    setSelectedSuggestion(selectedSuggestion: number) {
      state.selectedSuggestion = selectedSuggestion;
      return state;
    },

    resetSelectedSuggestion() {
      state.selectedSuggestion = 0;
      return state;
    },

    setLastPromptTokens(lastPromptTokens: number) {
      state.lastPromptTokens = lastPromptTokens;
      return state;
    },

    addTotalCost(cost: number) {
      state.totalCost += cost;
      return state;
    },

    setCursor(cursor: number) {
      state.cursor = clamp(cursor, 0, state.inputChars.length);
      return state;
    },

    setScrollOffset(scrollOffset: number) {
      state.scrollOffset = Math.max(0, scrollOffset);
      return state;
    },

    replaceInput(text: string, cursor = text.length) {
      state.inputChars.splice(0, state.inputChars.length, ...Array.from(text));
      state.cursor = clamp(cursor, 0, state.inputChars.length);
      return state;
    },

    insertText(text: string) {
      const chars = Array.from(text);
      state.inputChars.splice(state.cursor, 0, ...chars);
      state.cursor += chars.length;
      return state;
    },

    deleteBackward() {
      if (state.cursor <= 0) return false;
      state.inputChars.splice(state.cursor - 1, 1);
      state.cursor -= 1;
      return true;
    },

    deleteForward() {
      if (state.cursor >= state.inputChars.length) return false;
      state.inputChars.splice(state.cursor, 1);
      return true;
    }
  };
}
