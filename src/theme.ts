import chalk from 'chalk';
import type { Rgb } from './types';

export type ThemePalette = ReturnType<typeof createTheme>;

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHex(rgb: Rgb) {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map(channel => clampChannel(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: clampChannel(a.r + (b.r - a.r) * t),
    g: clampChannel(a.g + (b.g - a.g) * t),
    b: clampChannel(a.b + (b.b - a.b) * t)
  };
}

function defaultBackground(isLightTheme: boolean): Rgb {
  return isLightTheme ? { r: 250, g: 250, b: 250 } : { r: 24, g: 24, b: 28 };
}

export function createTheme() {
  let isLightTheme = false;
  let backgroundRgb = defaultBackground(false);

  function envThemeHint() {
    const termTheme = process.env.TERM_THEME?.toLowerCase();
    const vscodeTheme = process.env.VSCODE_THEME?.toLowerCase();

    if (process.env.ANSI_LIGHT === '1' || termTheme === 'light') return true;
    if (termTheme === 'dark') return false;
    if (vscodeTheme?.includes('light')) return true;
    if (vscodeTheme?.includes('dark')) return false;
    return null;
  }

  function parseColorFgbg(env = process.env): Rgb | null {
    const raw = env.COLORFGBG;
    if (!raw) return null;

    const parts = raw
      .split(';')
      .map(part => part.trim())
      .filter(Boolean);

    const tail = Number.parseInt(parts[parts.length - 1] ?? '', 10);
    if (!Number.isFinite(tail)) return null;

    const palette: Rgb[] = [
      { r: 0, g: 0, b: 0 },
      { r: 205, g: 0, b: 0 },
      { r: 0, g: 205, b: 0 },
      { r: 205, g: 205, b: 0 },
      { r: 0, g: 0, b: 238 },
      { r: 205, g: 0, b: 205 },
      { r: 0, g: 205, b: 205 },
      { r: 229, g: 229, b: 229 },
      { r: 127, g: 127, b: 127 },
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 255, g: 255, b: 0 },
      { r: 92, g: 92, b: 255 },
      { r: 255, g: 0, b: 255 },
      { r: 0, g: 255, b: 255 },
      { r: 255, g: 255, b: 255 }
    ];

    return tail >= 0 && tail < palette.length ? palette[tail] : null;
  }

  function relativeLuminance(rgb: Rgb) {
    return (rgb.r / 255) * 0.2126 + (rgb.g / 255) * 0.7152 + (rgb.b / 255) * 0.0722;
  }

  async function queryTerminalBackground(timeoutMs = 60): Promise<Rgb | null> {
    const input = process.stdin;
    const output = process.stdout;

    if (!input.isTTY || !output.isTTY) return null;

    const previousRawMode = typeof input.isRaw === 'boolean' ? input.isRaw : false;
    let changedRawMode = false;

    if (!previousRawMode && typeof input.setRawMode === 'function') {
      try {
        input.setRawMode(true);
        changedRawMode = true;
      } catch {}
    }

    return await new Promise(resolve => {
      let buffer = '';

      const cleanup = () => {
        input.off('data', onData);
        if (changedRawMode && typeof input.setRawMode === 'function') {
          try {
            input.setRawMode(previousRawMode);
          } catch {}
        }
      };

      const finish = (rgb: Rgb | null) => {
        clearTimeout(timer);
        cleanup();
        resolve(rgb);
      };

      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const match = /\x1b\]11;(?:rgba?):([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/[0-9a-fA-F]{1,4})?(?:\x07|\x1b\\)/i.exec(buffer);
        if (!match) return;

        const fromHex = (value: string) => {
          const parsed = Number.parseInt(value, 16);
          const bits = value.length * 4;
          return bits <= 8 ? parsed & 255 : (parsed >> (bits - 8)) & 255;
        };

        finish({ r: fromHex(match[1]), g: fromHex(match[2]), b: fromHex(match[3]) });
      };

      const timer = setTimeout(() => finish(null), timeoutMs);
      input.on('data', onData);

      try {
        output.write('\u001b]11;?\u0007');
      } catch {
        finish(null);
      }
    });
  }

  async function sync() {
    const hint = envThemeHint();
    if (hint !== null) isLightTheme = hint;

    const detectedBackground = (await queryTerminalBackground()) || parseColorFgbg() || defaultBackground(isLightTheme);
    backgroundRgb = detectedBackground;

    if (hint === null) isLightTheme = relativeLuminance(backgroundRgb) > 0.6;
  }

  return {
    sync,
    panelBg: () => toHex(mix(backgroundRgb, isLightTheme ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }, isLightTheme ? 0.04 : 0.06)),
    composerBg: () =>
      toHex(mix(backgroundRgb, isLightTheme ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }, isLightTheme ? 0.06 : 0.08)),
    foreground: (text: string) => text,
    dimmed: (text: string) => chalk.dim(text),
    subtle: (text: string) => chalk.dim(text),
    spinnerText: (text: string) => chalk.green(text)
  };
}
