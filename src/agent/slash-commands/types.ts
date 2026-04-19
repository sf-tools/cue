import type { ThinkingMode } from '@/config';
import type { AgentStore } from '@/store';
import type { EntryKind } from '@/types';

export type SlashCommandArgs = {
  raw: string;
  invocation: string;
  argsText: string;
  argv: string[];
};

export type ThreadShareState = 'private' | 'shared' | 'unknown';

export type SlashCommandContext = {
  store: AgentStore;
  cleanup(code?: number): void;
  compactConversation(options?: { manual?: boolean; force?: boolean }): Promise<boolean>;
  setCurrentModel(model: string): void;
  setThinkingMode(thinkingMode: ThinkingMode): void;
  setAutoCompactEnabled(enabled: boolean): void;
  setPlanningMode(enabled: boolean): void;
  cycleThinkingMode(): ThinkingMode;
  enqueueSubmission(text: string, options?: { planningMode?: boolean }): void;
  openCommandArgumentPicker(commandName: string): void;
  showFooterNotice(text: string, durationMs?: number): void;
  getActiveToolSummaries(): Array<{ names: string[]; description: string | null }>;
  getCurrentThreadShareState(): ThreadShareState;
  shareCurrentThread(): Promise<{ share: { shareId: string; sharedAt: string; url: string } }>;
  makeCurrentThreadPrivate(): Promise<{ ok: true }>;
  render(): void;
  persistEntry(kind: EntryKind, text: string): void;
  persistPlain(text: string): void;
  persistAnsi(text: string): void;
};

export type TextStyle = (text: string) => string;

export type SlashCommandArgumentSuggestion =
  | string
  | {
      value: string;
      label?: string;
      suffix?: string;
      detail?: string;
      labelStyle?: TextStyle;
      suffixStyle?: TextStyle;
      detailStyle?: TextStyle;
    };

export type SlashCommand = {
  name: string;
  aliases?: string[];
  specialHiddenAliases?: string[];
  description: string;
  suggestedInput?: string;
  argumentSuggestions?: SlashCommandArgumentSuggestion[];
  showArgumentSuggestionsOnExactInvocation?: boolean;
  isAvailable?(context: Pick<SlashCommandContext, 'getCurrentThreadShareState'>): boolean;
  unavailableDetail?(context: Pick<SlashCommandContext, 'getCurrentThreadShareState'>): string;
  execute(context: SlashCommandContext, args: SlashCommandArgs): Promise<void> | void;
};

export type SlashCommandInvocation = {
  command: SlashCommand;
  invocation: string;
  isAlias: boolean;
  hidden: boolean;
  specialHidden: boolean;
};

export type ResolvedSlashCommand = {
  command: SlashCommand;
  invocation: string;
  isAlias: boolean;
  argsText: string;
  argv: string[];
};

export type SlashCommandParseResult =
  | { type: 'empty' }
  | { type: 'unknown'; invocation: string }
  | ({ type: 'resolved' } & ResolvedSlashCommand);

export type SlashCommandSuggestion = {
  kind: 'slash-command';
  label: string;
  suffix?: string;
  detail: string;
  invocation: string;
  replacement: string;
  commandName: string;
  isAlias: boolean;
  disabled?: boolean;
  labelStyle?: TextStyle;
  suffixStyle?: TextStyle;
  detailStyle?: TextStyle;
};

export type SlashCommandQuery =
  | { type: 'invocation'; query: string }
  | { type: 'argument'; invocation: string; query: string };

export type SlashCommandRegistry = {
  commands: SlashCommand[];
  parse(input: string): SlashCommandParseResult | null;
  listSuggestions(query: SlashCommandQuery): SlashCommandSuggestion[];
};
