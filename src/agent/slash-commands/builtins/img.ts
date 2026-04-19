import type { SlashCommand } from '../types';

export const imgSlashCommand: SlashCommand = {
  name: 'img',
  aliases: ['image', 'paste-image'],
  description: 'Attach an image from the system clipboard so the model can see it.',
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);
    await context.attachImageFromClipboard();
  },
};
