import chalk from 'chalk';
import type { Rgb } from './types';

export type ThemePalette = ReturnType<typeof createTheme>;

export function createTheme() {
  let isLightTheme = false;

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

  function sync() {
    const hint = envThemeHint();
    if (hint !== null) {
      isLightTheme = hint;
      return;
    }

    const backgroundRgb = parseColorFgbg();
    if (backgroundRgb) isLightTheme = relativeLuminance(backgroundRgb) > 0.6;
  }

  return {
    sync,
    panelBg: () => (isLightTheme ? '#e8e8e8' : '#242428'),
    composerBg: () => (isLightTheme ? '#f5efe0' : '#242428'),
    foreground: (text: string) => (isLightTheme ? chalk.black(text) : chalk.white(text)),
    dimmed: (text: string) => (isLightTheme ? chalk.black.dim(text) : chalk.white.dim(text)),
    subtle: (text: string) => chalk.gray(text),
    spinnerText: (text: string) => chalk.green(text)
  };
}
