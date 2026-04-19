import { spawn, spawnSync } from 'node:child_process';

function hasCommand(bin: string) {
  const result = spawnSync('command', ['-v', bin], {
    shell: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1_500,
  });
  return result.status === 0;
}

async function writeToCommand(command: string, args: string[], text: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';

    child.on('error', reject);
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 1}`));
    });

    child.stdin.end(text);
  });
}

export function clipboardTextHelperHint() {
  if (process.platform === 'darwin') return 'pbcopy is required for clipboard support.';
  if (process.platform === 'win32') return 'clip.exe is required for clipboard support.';
  return 'Install wl-clipboard, xclip, or xsel for clipboard support.';
}

export async function copyTextToClipboard(text: string) {
  if (process.platform === 'darwin') {
    if (!hasCommand('pbcopy')) throw new Error(clipboardTextHelperHint());
    await writeToCommand('pbcopy', [], text);
    return;
  }

  if (process.platform === 'win32') {
    await writeToCommand('clip.exe', [], text.replace(/\n/g, '\r\n'));
    return;
  }

  if (hasCommand('wl-copy')) {
    await writeToCommand('wl-copy', [], text);
    return;
  }

  if (hasCommand('xclip')) {
    await writeToCommand('xclip', ['-selection', 'clipboard'], text);
    return;
  }

  if (hasCommand('xsel')) {
    await writeToCommand('xsel', ['--clipboard', '--input'], text);
    return;
  }

  throw new Error(clipboardTextHelperHint());
}
