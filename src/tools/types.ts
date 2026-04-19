import type { ApprovalRequest, ShellResult } from '@/types';

export type ToolFactoryOptions = {
  runUserShell: (cmd: string) => Promise<ShellResult>;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
};
