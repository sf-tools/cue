import type { ThinkingMode } from '@/config';
import type { UndoEntry } from '@/undo';
import type { ApprovalRequest, ChoiceRequest, ChoiceSelection, ShellResult } from '@/types';

export type ToolFactoryOptions = {
  runUserShell: (cmd: string) => Promise<ShellResult>;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  requestChoice: (request: ChoiceRequest) => Promise<ChoiceSelection>;
  setPlanningMode: (enabled: boolean) => void;
  getPlanningMode: () => boolean;
  getCurrentModel: () => string;
  getThinkingMode: () => ThinkingMode;
  pushUndoEntry: (entry: UndoEntry) => void;
  peekUndoEntry: () => UndoEntry | null;
  popUndoEntry: () => UndoEntry | null;
};
