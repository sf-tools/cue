import { USER_SHELL } from '@/config';
import { normalizePtyOutput } from './text';
import type { ShellResult } from './types';

export async function runUserShell(cmd: string): Promise<ShellResult> {
  const chunks: string[] = [];

  const terminal = new Bun.Terminal({
    cols: Math.floor(process.stdout.columns / 1.5) || 120,
    rows: Math.floor(process.stdout.rows / 1.5) || 30,
    data(_term, data) {
      chunks.push(new TextDecoder().decode(data));
    }
  });

  const proc = Bun.spawn([USER_SHELL, '-ic', cmd], {
    terminal,
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: process.env.COLORTERM || 'truecolor',
      FORCE_COLOR: process.env.FORCE_COLOR || '1',
      CLICOLOR: process.env.CLICOLOR || '1',
      CLICOLOR_FORCE: process.env.CLICOLOR_FORCE || '1'
    }
  });

  const exitCode = await proc.exited;
  terminal.close();

  return {
    exitCode,
    output: normalizePtyOutput(chunks.join(''))
  };
}
