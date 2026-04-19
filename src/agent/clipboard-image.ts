import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ClipboardImage = { bytes: Uint8Array; mediaType: string };

function which(bin: string): boolean {
  try {
    const result = spawnSync('command', ['-v', bin], { shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 && (result.stdout?.toString().trim().length ?? 0) > 0;
  } catch {
    return false;
  }
}

// AppleScript that writes the clipboard PNG to a path passed as the first
// argument. Avoids spawning `swift -` (cold start ~7s) entirely.
const APPLESCRIPT_CLIP_TO_FILE = `on run argv
  set targetPath to POSIX file (item 1 of argv)
  try
    set imgData to the clipboard as «class PNGf»
  on error
    try
      set imgData to the clipboard as TIFF picture
    on error
      return "no-image"
    end try
  end try
  set fp to open for access targetPath with write permission
  set eof fp to 0
  write imgData to fp
  close access fp
  return "ok"
end run`;

function macClipboardHasImage(): boolean {
  const result = spawnSync('osascript', ['-e', 'clipboard info'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 });
  if (result.status !== 0 || !result.stdout) return false;
  const info = result.stdout.toString();
  return /PNGf|TIFF picture|GIF picture|JPEG picture/.test(info);
}

const MAX_BUFFER = 64 * 1024 * 1024;

function spawnBytes(cmd: string, args: string[], input?: string): Buffer | null {
  const result = spawnSync(cmd, args, {
    input,
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.status !== 0) return null;
  if (!result.stdout || result.stdout.length === 0) return null;
  return result.stdout as Buffer;
}

function readClipboardMacOS(): ClipboardImage | null {
  if (!macClipboardHasImage()) return null;

  if (which('pngpaste')) {
    const buf = spawnBytes('pngpaste', ['-']);
    if (buf) return { bytes: new Uint8Array(buf), mediaType: 'image/png' };
  }

  // AppleScript fallback — pure macOS, no extra binaries needed.
  const dir = mkdtempSync(join(tmpdir(), 'cue-clip-'));
  try {
    const target = join(dir, 'clip.png');
    const result = spawnSync('osascript', ['-e', APPLESCRIPT_CLIP_TO_FILE, target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000
    });
    if (result.status !== 0) return null;
    if (result.stdout?.toString().trim() !== 'ok') return null;
    try {
      const bytes = readFileSync(target);
      return bytes.length > 0 ? { bytes: new Uint8Array(bytes), mediaType: 'image/png' } : null;
    } catch {
      return null;
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function readClipboardLinux(): ClipboardImage | null {
  if (process.env.WAYLAND_DISPLAY && which('wl-paste')) {
    const buf = spawnBytes('wl-paste', ['--type', 'image/png']);
    if (buf) return { bytes: new Uint8Array(buf), mediaType: 'image/png' };
  }
  if (which('xclip')) {
    for (const mediaType of ['image/png', 'image/jpeg']) {
      const buf = spawnBytes('xclip', ['-selection', 'clipboard', '-t', mediaType, '-o']);
      if (buf) return { bytes: new Uint8Array(buf), mediaType };
    }
  }
  return null;
}

function readClipboardWindows(): ClipboardImage | null {
  // PowerShell can extract a clipboard image by saving it to a temp file.
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'cue-clip-'));
    const target = join(dir, 'clipboard.png');
    const ps = `Add-Type -AssemblyName System.Windows.Forms; ` +
      `if ([System.Windows.Forms.Clipboard]::ContainsImage()) { ` +
      `[System.Windows.Forms.Clipboard]::GetImage().Save('${target.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0 } else { exit 1 }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status === 0) {
      try {
        const bytes = readFileSync(target);
        return { bytes: new Uint8Array(bytes), mediaType: 'image/png' };
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (process.platform === 'darwin') return readClipboardMacOS();
  if (process.platform === 'linux') return readClipboardLinux();
  if (process.platform === 'win32') return readClipboardWindows();
  return null;
}

/** Returns a human-readable hint for installing a clipboard helper on the current platform. */
export function clipboardHelperHint(): string {
  if (process.platform === 'darwin') return 'Install pngpaste (`brew install pngpaste`) for fastest clipboard reads.';
  if (process.platform === 'linux') return 'Install wl-clipboard (Wayland) or xclip (X11) for clipboard image support.';
  if (process.platform === 'win32') return 'Requires PowerShell with .NET (built into Windows).';
  return 'Clipboard image reading is not supported on this platform.';
}
