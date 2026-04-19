import type { ThinkingMode } from '@/config';
import type { ApprovalRequest, ShellResult } from '@/types';

export type ToolFactoryOptions = {
  runUserShell: (cmd: string) => Promise<ShellResult>;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  getCurrentModel: () => string;
  getThinkingMode: () => ThinkingMode;
};
