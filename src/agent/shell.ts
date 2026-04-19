import { spawn as spawnPty } from '@homebridge/node-pty-prebuilt-multiarch';

import { USER_SHELL } from '@/config';
import { normalizePtyOutput } from '@/text';
import type { ShellResult } from '@/types';

export async function runUserShell(cmd: string): Promise<ShellResult> {
  return await new Promise((resolve, reject) => {
    const chunks: string[] = [];

    try {
      const proc = spawnPty(USER_SHELL, ['-ic', cmd], {
        name: 'xterm-256color',
        cols: Math.floor(process.stdout.columns / 1.5) || 120,
        rows: Math.floor(process.stdout.rows / 1.5) || 30,
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

      const dataDisposable = proc.onData(data => {
        chunks.push(data);
      });

      const exitDisposable = proc.onExit(({ exitCode, signal }) => {
        dataDisposable.dispose();
        exitDisposable.dispose();

        if (signal !== undefined) chunks.push(`\nprocess exited with signal ${signal}`);

        resolve({
          exitCode,
          output: normalizePtyOutput(chunks.join(''))
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}
