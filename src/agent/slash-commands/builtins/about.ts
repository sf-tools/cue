import { APP_RELEASE_DATE_ISO, APP_VERSION } from '@/config';
import { loadCueCloudAuth } from '@/cloud/auth-storage';
import type { SlashCommand } from '../types';
import { spawnSync } from 'node:child_process';

function formatRows(rows: Array<[string, string]>) {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
}

function antVersion() {
  const result = spawnSync('ant', ['--version-raw'], {
    shell: true,
    timeout: 500,
  });
  return `v${result.stdout}`.trim() ?? 'n/a';
}

export const aboutSlashCommand: SlashCommand = {
  name: 'about',
  description: 'Show CLI version, system, and account info and copy it to the clipboard.',
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const auth = await loadCueCloudAuth();
    const rows: Array<[string, string]> = [
      ['app', 'Cue'],
      ['version', APP_VERSION],
      ['released', APP_RELEASE_DATE_ISO],
      ['node', process.version],
      ['ant', antVersion()],
      ['platform', `${process.platform} ${process.arch}`],
      ['cwd', process.cwd()],
      ['model', context.store.getState().currentModel],
      ['reasoning', context.store.getState().thinkingMode],
      ['conversation id', context.getSessionId()],
      ['request id', context.getLastRequestId() ?? 'n/a'],
      ['session title', context.getThreadTitle() ?? 'untitled'],
      ['account', auth?.email ?? auth?.userId ?? 'not signed in'],
      ['cloud', auth?.baseUrl ?? 'not signed in'],
    ];

    const text = formatRows(rows);
    context.printEntries([{ type: 'plain', text }]);

    try {
      await context.copyToClipboard(text);
      context.showFooterNotice('About copied to clipboard');
    } catch {
      context.showFooterNotice('About shown · clipboard unavailable');
    }
  },
};
