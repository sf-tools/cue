import type { SlashCommand, SlashCommandInvocation, SlashCommandParseResult, SlashCommandQuery, SlashCommandSuggestion } from './types';

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

export function currentSlashCommandQuery(inputChars: string[], cursor: number): SlashCommandQuery | null {
  const beforeCursor = inputChars.slice(0, cursor).join('');
  const invocationMatch = beforeCursor.match(/^\/([^\s]*)$/);
  if (invocationMatch) return { type: 'invocation', query: invocationMatch[1] };

  const argumentMatch = beforeCursor.match(/^\/([^\s]+)\s+([^\s]*)$/);
  if (!argumentMatch) return null;

  return {
    type: 'argument',
    invocation: normalizeInvocation(argumentMatch[1]),
    query: argumentMatch[2]
  };
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

    listSuggestions(query: SlashCommandQuery) {
      if (query.type === 'argument') {
        const resolved = invocationMap.get(query.invocation);
        const values = resolved?.command.argumentSuggestions ?? [];
        const normalizedQuery = normalizeInvocation(query.query);

        return values
          .filter(value => {
            if (!normalizedQuery) return true;
            const normalizedValue = normalizeInvocation(value);
            return normalizedValue.startsWith(normalizedQuery) || normalizedValue.includes(normalizedQuery);
          })
          .slice(0, 6)
          .map<SlashCommandSuggestion>(value => {
            const canonicalInvocation = normalizeInvocation(resolved?.command.name ?? query.invocation);

            return {
              kind: 'slash-command',
              label: `/${canonicalInvocation}`,
              suffix: ` ${value}`,
              detail: resolved?.command.description ?? '',
              invocation: canonicalInvocation,
              replacement: `/${canonicalInvocation} ${value}`,
              commandName: resolved?.command.name ?? query.invocation,
              isAlias: Boolean(resolved?.isAlias)
            };
          })
          .sort(compareSuggestions);
      }

      const normalizedQuery = normalizeInvocation(query.query);

      const suggestions = sortedInvocations
        .filter(({ invocation, hidden, specialHidden }) => {
          if (!normalizedQuery) return !hidden;
          if (specialHidden) return invocation.startsWith(normalizedQuery);
          if (hidden) return false;
          return invocation.startsWith(normalizedQuery) || invocation.includes(normalizedQuery);
        })
        .slice(0, 6)
        .map<SlashCommandSuggestion>(({ command, invocation, isAlias, specialHidden }) => {
          const canonicalInvocation = normalizeInvocation(command.name);
          const replacementInvocation = specialHidden ? canonicalInvocation : invocation;

          return {
            kind: 'slash-command',
            label: `/${replacementInvocation}`,
            suffix: command.suggestedInput ? ` ${command.suggestedInput}` : undefined,
            detail: isAlias ? `Alias for /${command.name} · ${command.description}` : command.description,
            invocation: replacementInvocation,
            replacement: `/${replacementInvocation}`,
            commandName: command.name,
            isAlias
          };
        });

      return suggestions.sort(compareSuggestions);
    }
  };
}
