import type { AgentStore } from '@/store';
import type { EntryKind } from '@/types';

export type SlashCommandArgs = {
  raw: string;
  invocation: string;
  argsText: string;
  argv: string[];
};

export type SlashCommandContext = {
  store: AgentStore;
  cleanup(code?: number): void;
  compactConversation(options?: { manual?: boolean; force?: boolean }): Promise<boolean>;
  showFooterNotice(text: string, durationMs?: number): void;
  render(): void;
  persistEntry(kind: EntryKind, text: string): void;
  persistPlain(text: string): void;
  persistAnsi(text: string): void;
};

export type SlashCommand = {
  name: string;
  aliases?: string[];
  specialHiddenAliases?: string[];
  description: string;
  suggestedInput?: string;
  argumentSuggestions?: string[];
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

export type SlashCommandParseResult = { type: 'empty' } | { type: 'unknown'; invocation: string } | ({ type: 'resolved' } & ResolvedSlashCommand);

export type SlashCommandSuggestion = {
  kind: 'slash-command';
  label: string;
  suffix?: string;
  detail: string;
  invocation: string;
  replacement: string;
  commandName: string;
  isAlias: boolean;
};

export type SlashCommandQuery = { type: 'invocation'; query: string } | { type: 'argument'; invocation: string; query: string };

export type SlashCommandRegistry = {
  commands: SlashCommand[];
  parse(input: string): SlashCommandParseResult | null;
  listSuggestions(query: SlashCommandQuery): SlashCommandSuggestion[];
};
