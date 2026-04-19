import type { SlashCommand } from '../types';

function formatToolNames(names: string[]) {
  const [primary, ...aliases] = names;
  if (aliases.length === 0) return primary;
  return `${primary} (alias${aliases.length === 1 ? '' : 'es'}: ${aliases.join(', ')})`;
}

function truncate(text: string, maxLength = 88) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export const toolsSlashCommand: SlashCommand = {
  name: 'tools',
  description: 'List the currently available agent tools.',
  execute({ store, getActiveToolSummaries, persistPlain }, args) {
    if (args.argv.length > 0) throw new Error('/tools does not accept arguments');

    const planningMode = store.getState().planningMode;
    const tools = getActiveToolSummaries();
    const header = `Available tools (${tools.length} active${planningMode ? ' · planning mode' : ''})`;
    const lines = tools.map(tool => {
      const description = tool.description
        ? truncate(tool.description)
        : 'No description available.';
      return `- ${formatToolNames(tool.names)} — ${description}`;
    });

    if (planningMode) lines.push('', 'Tip: run /planning off to restore the full toolset.');

    persistPlain([header, '', ...lines].join('\n'));
  },
};
