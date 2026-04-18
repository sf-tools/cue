import { createInitialState } from './state';

import type { ModelMessage } from 'ai';
import type { HistoryEntry } from '@/types';
import type { AgentState } from './types';

export type AgentStore = ReturnType<typeof createAgentStore>;

function hasVisibleContent(text: string) {
  return text.trim().length > 0;
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
      if (hasVisibleContent(entry.text)) state.historyEntries.push(entry);
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
