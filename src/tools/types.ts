import type { ShellResult } from '@/types';

export type ToolFactoryOptions = {
  runUserShell: (cmd: string) => Promise<ShellResult>;
};
