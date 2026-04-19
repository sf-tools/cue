import { clearCueCloudAuth, loadCueCloudAuth } from '@/cloud/auth-storage';
import { logoutCueCloud } from '@/cloud/client';
import type { SlashCommand } from '../types';
import { EntryKind } from '@/types';

export const logoutSlashCommand: SlashCommand = {
  name: 'logout',
  description: 'Log out from Cue Cloud',
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error('/logout does not accept arguments');

    const auth = await loadCueCloudAuth();
    if (!auth) {
      context.persistEntry(EntryKind.Meta, 'not logged in');
      return;
    }

    try {
      await logoutCueCloud(auth);
    } catch {}

    await clearCueCloudAuth();
    context.persistEntry(EntryKind.Meta, 'logged out');
    context.showFooterNotice('cue cloud disconnected');
    context.cleanup(0);
  }
};
