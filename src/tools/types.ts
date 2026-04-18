import type { EntryKind, ShellResult } from '@/types';

export type ToolFactoryOptions = {
  persistEntry: (kind: EntryKind, text: string) => void;
  runUserShell: (cmd: string) => Promise<ShellResult>;
};
