import type { EntryKind, ShellResult } from '@/agent/types';

export type ToolFactoryOptions = {
  persistEntry: (kind: EntryKind, text: string) => void;
  runUserShell: (cmd: string) => Promise<ShellResult>;
};
