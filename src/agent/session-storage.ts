import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

export type CueSessionListEntry = {
  sessionId: string;
  cwd: string;
  savedAt: string;
  title?: string;
  preview?: string;
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

function summarizeHistoryEntry(entry: HistoryEntry): string | null {
  if (entry.type === 'entry') return entry.text;
  if (entry.type === 'plain') return entry.text;
  if (entry.type === 'compacted') return entry.summary;
  if (entry.type === 'tool') return entry.title ?? entry.toolName;
  return null;
}

function summarizeSnapshotPreview(snapshot: CueSessionSnapshot): string | undefined {
  for (let index = snapshot.state.historyEntries.length - 1; index >= 0; index -= 1) {
    const text = summarizeHistoryEntry(snapshot.state.historyEntries[index]);
    if (!text) continue;

    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized) return normalized;
  }

  return undefined;
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

export async function listCueSessionSnapshots(
  options: { cwd?: string; root?: string } = {},
): Promise<CueSessionListEntry[]> {
  const root = options.root ?? DEFAULT_SESSION_DIR;
  const targetCwd = options.cwd ? resolve(options.cwd) : null;

  try {
    const names = await readdir(root);
    const entries: Array<CueSessionListEntry | null> = await Promise.all(
      names
        .filter(name => name.endsWith('.json'))
        .map(async name => {
          try {
            const raw = await readFile(join(root, name), 'utf8');
            const parsed = JSON.parse(raw) as CueSessionSnapshot;
            if (!parsed || parsed.version !== 1 || !parsed.sessionId || !parsed.cwd || !parsed.savedAt)
              return null;
            if (targetCwd && resolve(parsed.cwd) !== targetCwd) return null;

            const entry: CueSessionListEntry = {
              sessionId: parsed.sessionId,
              cwd: parsed.cwd,
              savedAt: parsed.savedAt,
              ...(parsed.title ? { title: parsed.title } : {}),
              ...(summarizeSnapshotPreview(parsed)
                ? { preview: summarizeSnapshotPreview(parsed) }
                : {}),
            };
            return entry;
          } catch {
            return null;
          }
        }),
    );

    return entries
      .filter((entry): entry is CueSessionListEntry => entry !== null)
      .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
  } catch {
    return [];
  }
}
