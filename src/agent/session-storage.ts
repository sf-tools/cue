import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInitialState } from '@/store/state';
import type { AgentState } from '@/store/types';
import type { HistoryEntry } from '@/types';

export type CueSessionSnapshot = {
  version: 1;
  sessionId: string;
  cwd: string;
  savedAt: string;
  title?: string;
  state: {
    messages: AgentState['messages'];
    historyEntries: AgentState['historyEntries'];
    inputChars: string[];
    cursor: number;
    totalCost: number;
    currentModel: string;
    thinkingMode: AgentState['thinkingMode'];
    autoCompactEnabled: boolean;
    planningMode: boolean;
  };
};

const DEFAULT_SESSION_DIR = join(homedir(), '.cue', 'sessions');

export function getCueSessionPath(sessionId: string, root = DEFAULT_SESSION_DIR) {
  return join(root, `${sessionId}.json`);
}

export function createSnapshotFromState(
  sessionId: string,
  cwd: string,
  state: AgentState,
  title?: string | null,
): CueSessionSnapshot {
  const normalizedTitle = title?.trim() ? title.trim() : undefined;

  return {
    version: 1,
    sessionId,
    cwd,
    savedAt: new Date().toISOString(),
    ...(normalizedTitle ? { title: normalizedTitle } : {}),
    state: {
      messages: state.messages,
      historyEntries: state.historyEntries,
      inputChars: state.inputChars,
      cursor: state.cursor,
      totalCost: state.totalCost,
      currentModel: state.currentModel,
      thinkingMode: state.thinkingMode,
      autoCompactEnabled: state.autoCompactEnabled,
      planningMode: state.planningMode,
    },
  };
}

function sanitizeHistoryEntriesForResume(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.map(entry => {
    if (entry.type !== 'tool' || entry.status !== 'running') return entry;

    return {
      ...entry,
      status: 'failed',
      errorText: entry.errorText || 'interrupted when the session was resumed',
    };
  });
}

export function hydrateStateFromSnapshot(snapshot: CueSessionSnapshot): AgentState {
  const initial = createInitialState();

  return {
    ...initial,
    autoCompactEnabled: snapshot.state.autoCompactEnabled,
    currentModel: snapshot.state.currentModel,
    cursor: snapshot.state.cursor,
    historyEntries: sanitizeHistoryEntriesForResume(snapshot.state.historyEntries),
    inputChars: snapshot.state.inputChars,
    messages: snapshot.state.messages,
    planningMode: snapshot.state.planningMode,
    thinkingMode: snapshot.state.thinkingMode,
    totalCost: snapshot.state.totalCost,
  };
}

export async function saveCueSessionSnapshot(
  snapshot: CueSessionSnapshot,
  root = DEFAULT_SESSION_DIR,
) {
  const path = getCueSessionPath(snapshot.sessionId, root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function loadCueSessionSnapshot(
  sessionId: string,
  root = DEFAULT_SESSION_DIR,
): Promise<CueSessionSnapshot | null> {
  try {
    const raw = await readFile(getCueSessionPath(sessionId, root), 'utf8');
    const parsed = JSON.parse(raw) as CueSessionSnapshot;
    if (!parsed || parsed.version !== 1 || parsed.sessionId !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}
