import type { SlashCommand, SlashCommandInvocation, SlashCommandParseResult, SlashCommandSuggestion } from './types';

function normalizeInvocation(value: string) {
  return value.trim().replace(/^\//, '').toLowerCase();
}

function splitArgs(argsText: string) {
  const trimmed = argsText.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

function compareSuggestions(a: SlashCommandSuggestion, b: SlashCommandSuggestion) {
  return a.label.localeCompare(b.label);
}

export function currentSlashCommandQuery(inputChars: string[], cursor: number) {
  const beforeCursor = inputChars.slice(0, cursor).join('');
  return beforeCursor.match(/^\/([^\s]*)$/)?.[1] ?? null;
}

export function createSlashCommandRegistry(commands: SlashCommand[]) {
  const invocations: SlashCommandInvocation[] = [];
  const invocationMap = new Map<string, SlashCommandInvocation>();

  for (const command of commands) {
    const primaryInvocation = normalizeInvocation(command.name);
    const names = [
      { name: command.name, hidden: false, specialHidden: false },
      ...(command.aliases ?? []).map(name => ({ name, hidden: false, specialHidden: false })),
      ...(command.specialHiddenAliases ?? []).map(name => ({ name, hidden: true, specialHidden: true }))
    ];

    for (const { name, hidden, specialHidden } of names) {
      const normalized = normalizeInvocation(name);
      if (!normalized) throw new Error('slash commands must have a non-empty name');
      if (invocationMap.has(normalized)) throw new Error(`duplicate slash command: /${normalized}`);

      const invocation: SlashCommandInvocation = {
        command,
        invocation: normalized,
        isAlias: normalized !== primaryInvocation,
        hidden,
        specialHidden
      };

      invocationMap.set(normalized, invocation);
      invocations.push(invocation);
    }
  }

  const sortedInvocations = invocations.slice().sort((a, b) => a.invocation.localeCompare(b.invocation));

  return {
    commands: commands.slice(),

    parse(input: string): SlashCommandParseResult | null {
      const trimmed = input.trim();
      if (!trimmed.startsWith('/')) return null;
      if (trimmed === '/') return { type: 'empty' };

      const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/);
      if (!match) return { type: 'empty' };

      const invocation = normalizeInvocation(match[1]);
      const resolved = invocationMap.get(invocation);
      if (!resolved) return { type: 'unknown', invocation };

      const argsText = match[2]?.trim() ?? '';

      return {
        type: 'resolved',
        command: resolved.command,
        invocation: resolved.invocation,
        isAlias: resolved.isAlias,
        argsText,
        argv: splitArgs(argsText)
      };
    },

    listSuggestions(query: string) {
      const normalizedQuery = normalizeInvocation(query);

      const suggestions = sortedInvocations
        .filter(({ invocation, hidden, specialHidden }) => {
          if (!normalizedQuery) return !hidden;
          if (specialHidden) return invocation.startsWith(normalizedQuery);
          if (hidden) return false;
          return invocation.startsWith(normalizedQuery) || invocation.includes(normalizedQuery);
        })
        .slice(0, 6)
        .map<SlashCommandSuggestion>(({ command, invocation, isAlias }) => ({
          kind: 'slash-command',
          label: `/${invocation}`,
          detail: isAlias ? `Alias for /${command.name} · ${command.description}` : command.description,
          invocation,
          commandName: command.name,
          isAlias
        }));

      return suggestions.sort(compareSuggestions);
    }
  };
}
