import { streamText, tool, stepCountIs, type ModelMessage } from 'ai';
import { openai } from '@ai-sdk/openai';
import chalk from 'chalk';
import { readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { emitKeypressEvents } from 'node:readline';
import { createLogUpdate } from 'log-update';
import { version } from '../package.json';

import ora from 'ora';
import approx from 'approximate-number';
import { calcPrice } from '@pydantic/genai-prices';
import stringWidth from 'string-width';
import { z } from 'zod';

type EntryKind = 'user' | 'assistant' | 'tool' | 'shell' | 'error' | 'meta';
type LogUpdate = ((...text: string[]) => void) & {
  clear(): void;
  done(): void;
  persist(...text: string[]): void;
};
type ShellResult = {
  exitCode: number;
  output: string;
};
type Rgb = {
  r: number;
  g: number;
  b: number;
};

const APP_NAME = 'Cue';
const MODEL = 'gpt-5.4';
const MODEL_META = calcPrice({ input_tokens: 0, output_tokens: 0 }, MODEL, { providerId: 'openai' });
const CONTEXT_WINDOW = MODEL_META?.model?.context_window ?? 1_000_000;
const spinner = ora({ spinner: 'dots10', color: 'green', isEnabled: false });
const USER_SHELL = process.env.SHELL || '/bin/zsh';
const messages: ModelMessage[] = [
  {
    role: 'system',
    content: `You are a terse coding agent in ${process.cwd()}. Use tools to read, write, and run shell commands. Explain briefly what you did.`
  }
];

const inputChars: string[] = [];
const historyBlocks: string[][] = [];

let cursor = 0;
let scrollOffset = 0;
let busy = false;
let closed = false;

let liveAssistantText = '';
let selectedSuggestion = 0;
let lastPromptTokens = 0;
let totalCost = 0;
let abortController: AbortController | null = null;

const log: LogUpdate = createLogUpdate(process.stdout, {
  showCursor: false,
  defaultWidth: 100,
  defaultHeight: 30
}) as LogUpdate;

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
const widthOf = (s: string) => stringWidth(stripAnsi(s));
const repeat = (ch: string, count: number) => ch.repeat(Math.max(0, count));
const plain = (s: string) => stripAnsi(s).replace(/\r/g, '');

let isLightTheme = false;
let backgroundRgb: Rgb | null = null;

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

async function syncTheme() {
  const hint = envThemeHint();
  if (hint !== null) {
    isLightTheme = hint;
    return;
  }

  backgroundRgb = parseColorFgbg();
  if (backgroundRgb) isLightTheme = relativeLuminance(backgroundRgb) > 0.6;
}

function panelBg() {
  return isLightTheme ? '#e8e8e8' : '#242428';
}

function composerBg() {
  return isLightTheme ? '#f5efe0' : '#242428';
}

function foreground(text: string) {
  return isLightTheme ? chalk.black(text) : chalk.white(text);
}

function dimmed(text: string) {
  return isLightTheme ? chalk.black.dim(text) : chalk.white.dim(text);
}

function subtle(text: string) {
  return isLightTheme ? chalk.gray(text) : chalk.gray(text);
}

function spinnerText(text: string) {
  return isLightTheme ? chalk.green(text) : chalk.green(text);
}

function normalizePtyOutput(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

function formatWorkspacePath(path: string) {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

async function runUserShell(cmd: string): Promise<ShellResult> {
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

function charWidth(ch: string) {
  return Math.max(1, stringWidth(ch));
}

function installSegmentContainingPolyfill() {
  if (typeof Intl?.Segmenter !== 'function') return;

  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment('');
  const proto = Object.getPrototypeOf(segments);
  if (typeof proto.containing === 'function') return;

  Object.defineProperty(proto, 'containing', {
    value(index: number) {
      if (typeof index !== 'number' || index < 0) return undefined;
      for (const segment of this as Iterable<{ index: number; segment: string }>) {
        const start = segment.index;
        const end = start + segment.segment.length;
        if (index >= start && index < end) return segment;
      }
      return undefined;
    }
  });
}

function frameWidth() {
  const cols = process.stdout.columns || 100;
  return Math.max(40, cols - 2);
}

function leftPad() {
  return ' ';
}

function wrapLine(line: string, width: number) {
  if (width <= 0) return [''];
  if (!line) return [''];

  const out: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const ch of Array.from(line)) {
    const w = charWidth(ch);
    if (current && currentWidth + w > width) {
      out.push(current);
      current = ch;
      currentWidth = w;
      continue;
    }

    current += ch;
    currentWidth += w;
  }

  out.push(current);
  return out;
}

function wrapText(text: string, width: number) {
  return plain(text)
    .split('\n')
    .flatMap(line => wrapLine(line, width));
}

function panelLine(text: string, width: number) {
  const fill = repeat(' ', Math.max(0, width - widthOf(text) - 2));
  return `${leftPad()}${chalk.bgHex(panelBg())(` ${text}${fill} `)}`;
}

function renderEntry(kind: EntryKind, text: string, width = frameWidth()) {
  if (kind === 'user') {
    return wrapText(text, Math.max(1, width - 2)).map(line => panelLine(foreground(line), width));
  }

  const pad = leftPad();
  const baseWidth = Math.max(1, width - 2);

  if (kind === 'assistant') {
    return wrapText(text, baseWidth).map(line => `${pad}${foreground(line)}`);
  }

  if (kind === 'shell') {
    return wrapText(text, Math.max(1, baseWidth - 2)).map((line, index) => `${pad}${index === 0 ? dimmed('$ ') : '  '}${foreground(line)}`);
  }

  if (kind === 'error') {
    return wrapText(text, Math.max(1, baseWidth - 2)).map((line, index) => `${pad}${index === 0 ? chalk.red('! ') : '  '}${chalk.redBright(line)}`);
  }

  const prefix = kind === 'tool' ? `${dimmed('· ')} ` : '';
  const indent = repeat(' ', widthOf(prefix));
  return wrapText(text, Math.max(1, baseWidth - widthOf(prefix))).map((line, index) => `${pad}${index === 0 ? prefix : indent}${dimmed(line)}`);
}

function pushHistory(lines: string[]) {
  if (!lines.some(line => line.trim().length > 0)) return;
  historyBlocks.push([...lines, '']);
}

function persistEntry(kind: EntryKind, text: string) {
  if (!text.trim()) return;
  pushHistory(renderEntry(kind, text));
  render();
}

function persistPlain(text: string) {
  if (!text.trim()) return;
  pushHistory(wrapText(text, frameWidth()).map(line => `${leftPad()}${line}`));
  render();
}

function persistAnsi(text: string) {
  if (!text.trim()) return;
  pushHistory(text.split('\n').map(line => `${leftPad()}${line}`));
  render();
}

function renderHeader() {
  const pad = leftPad();
  return [
    '',
    `${pad}${foreground(chalk.bold(APP_NAME))}`,
    `${pad}${dimmed(version)}`,
    // `${pad}${dimmed("")}`,
    ''
  ];
}

function renderOutputPreview() {
  if (!liveAssistantText) return [];

  const maxLines = Math.max(3, (process.stdout.rows || 24) - 12);
  const lines = renderEntry('assistant', liveAssistantText);
  return [...lines.slice(-maxLines), ''];
}

function normalizeScroll(viewWidth: number) {
  if (cursor < scrollOffset) scrollOffset = cursor;

  let used = 0;
  for (let i = cursor - 1; i >= scrollOffset; i--) used += charWidth(inputChars[i]);

  while (used > viewWidth && scrollOffset < cursor) {
    used -= charWidth(inputChars[scrollOffset]);
    scrollOffset += 1;
  }
}

function renderInputContent(viewWidth: number) {
  normalizeScroll(viewWidth);

  let used = 0;
  let end = scrollOffset;
  while (end < inputChars.length) {
    const w = charWidth(inputChars[end]);
    if (used + w > viewWidth) break;
    used += w;
    end += 1;
  }

  const visibleChars = inputChars.slice(scrollOffset, end);
  const cursorIndex = Math.max(0, Math.min(visibleChars.length, cursor - scrollOffset));
  const activeChar = visibleChars[cursorIndex] ?? ' ';
  const before = visibleChars.slice(0, cursorIndex).join('');
  const after = visibleChars.slice(cursorIndex + (cursorIndex < visibleChars.length ? 1 : 0)).join('');
  const cursorCell = chalk.inverse(activeChar);
  const rendered = `${before}${cursorCell}${after}`;
  const visibleWidth = widthOf(visibleChars.join('')) + (cursorIndex >= visibleChars.length ? 1 : 0);

  return {
    rendered,
    fill: repeat(' ', Math.max(0, viewWidth - visibleWidth))
  };
}

function currentMentionQuery() {
  const beforeCursor = inputChars.slice(0, cursor).join('');
  const match = beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
  return match ? match[1] : null;
}

function currentMentionMatch() {
  const beforeCursor = inputChars.slice(0, cursor).join('');
  return beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
}

function mentionSuggestions() {
  const query = currentMentionQuery();
  if (query === null) return [];

  try {
    const entries = readdirSync(process.cwd(), { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => ({
        label: entry.isDirectory() ? `${entry.name}/` : entry.name,
        isDirectory: entry.isDirectory()
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.label.localeCompare(b.label);
      });

    const normalized = query.toLowerCase();
    return entries
      .filter(entry => entry.label.toLowerCase().includes(normalized))
      .slice(0, 6)
      .map(entry => entry.label);
  } catch {
    return [];
  }
}

function clampSuggestionIndex() {
  const suggestions = mentionSuggestions();
  if (suggestions.length === 0) {
    selectedSuggestion = 0;
    return suggestions;
  }

  selectedSuggestion = Math.max(0, Math.min(selectedSuggestion, suggestions.length - 1));
  return suggestions;
}

function moveSuggestionSelection(delta: number) {
  const suggestions = mentionSuggestions();
  if (suggestions.length === 0) return false;

  selectedSuggestion = (selectedSuggestion + delta + suggestions.length) % suggestions.length;
  render();
  return true;
}

function acceptSuggestion() {
  const suggestions = clampSuggestionIndex();
  const suggestion = suggestions[selectedSuggestion];
  const match = currentMentionMatch();
  if (!suggestion || !match) return false;

  const beforeCursor = inputChars.slice(0, cursor).join('');
  const afterCursor = inputChars.slice(cursor).join('');
  const fullMatch = match[0];
  const leadingWhitespace = fullMatch.startsWith(' ') ? ' ' : '';
  const replacement = `${leadingWhitespace}@${suggestion}${suggestion.endsWith('/') ? '' : ' '}`;
  const next = `${beforeCursor.slice(0, beforeCursor.length - fullMatch.length)}${replacement}${afterCursor}`;

  inputChars.splice(0, inputChars.length, ...Array.from(next));
  cursor = beforeCursor.length - fullMatch.length + replacement.length;
  scrollOffset = 0;
  selectedSuggestion = 0;
  render();
  return true;
}

function renderComposer(width = frameWidth()) {
  const pad = leftPad();
  const contentWidth = Math.max(1, width - 4);
  const prompt = inputChars.length === 0 ? dimmed('→') : foreground('→');

  if (inputChars.length === 0) {
    const placeholder = `${chalk.inverse('P')}${dimmed('lan, search, build anything')}`;
    const fill = repeat(' ', Math.max(0, contentWidth - 1 - widthOf('Plan, search, build anything')));
    return [`${pad}${chalk.bgHex(composerBg())(` ${prompt} ${placeholder}${fill} `)}`];
  }

  const { rendered, fill } = renderInputContent(contentWidth);
  return [`${pad}${chalk.bgHex(composerBg())(` ${prompt} ${rendered}${fill} `)}`];
}

function renderSuggestions() {
  const suggestions = clampSuggestionIndex();
  if (!suggestions.length) return [];

  const pad = leftPad();
  return suggestions.map((suggestion, index) =>
    index === selectedSuggestion ? `${pad}${foreground('→')} ${foreground(suggestion)}` : `${pad}  ${dimmed(suggestion)}`
  );
}

function renderFooter(width = frameWidth()) {
  const cwd = formatWorkspacePath(process.cwd());
  const frame = spinner.frame().trim();
  const ctxLabel = approx(CONTEXT_WINDOW, { capital: false, precision: 2 });
  const pct = (lastPromptTokens / CONTEXT_WINDOW) * 100;
  const contextPct = lastPromptTokens > 0 ? `${pct < 1 ? '<1' : Math.round(pct)}% of ${ctxLabel}` : '';
  const cost = totalCost > 0 ? `$${totalCost.toFixed(4)}` : '';
  const stats = [contextPct, cost].filter(Boolean).join(' · ');
  const modeText = busy ? spinnerText(`${frame} Thinking...`) : stats ? `${dimmed(stats)} ${subtle('·')} ${foreground(MODEL)}` : foreground(MODEL);
  return ['', `${leftPad()}${modeText}`, `${leftPad()}${subtle(cwd.padEnd(Math.max(width, cwd.length)))}`];
}

function render() {
  if (closed) return;

  const header = renderHeader();
  const transcript = historyBlocks.flat();
  const preview = renderOutputPreview();
  const composer = renderComposer();
  const suggestions = renderSuggestions();
  const footer = renderFooter();
  const rows = process.stdout.rows || 30;
  const reserved = header.length + composer.length + suggestions.length + footer.length;
  const available = Math.max(0, rows - reserved);
  const body = [...transcript, ...preview].slice(-available);

  log([...header, ...body, ...composer, ...suggestions, ...footer].join('\n'));
}

async function expand(input: string) {
  let out = input;
  for (const match of input.match(/@[^\s]+/g) || []) {
    try {
      const path = match.slice(1);
      const content = await readFile(path, 'utf8');
      out += `\n\n<file path="${path}">\n${content}\n</file>`;
    } catch {}
  }
  return out;
}

async function runShell(cmd: string) {
  busy = true;
  render();

  try {
    const { output, exitCode } = await runUserShell(cmd);
    const trimmed = output.trimEnd();
    if (trimmed) persistAnsi(trimmed);
    else if (exitCode === 0) persistPlain('(no output)');
    else persistEntry('error', `command exited with code ${exitCode}`);
  } catch (error: any) {
    persistEntry('error', plain(error.message));
  } finally {
    busy = false;
    render();
  }
}

const tools = {
  read: tool({
    description: 'Read a file from disk',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      persistEntry('tool', `read(${path})`);
      return await readFile(path, 'utf8');
    }
  }),
  write: tool({
    description: 'Write content to a file',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      persistEntry('tool', `write(${path})`);
      await writeFile(path, content);
      return `wrote ${content.length} bytes to ${path}`;
    }
  }),
  bash: tool({
    description: 'Run a shell command',
    inputSchema: z.object({ cmd: z.string() }),
    execute: async ({ cmd }) => {
      persistEntry('shell', cmd);
      try {
        const { output, exitCode } = await runUserShell(cmd);
        const trimmed = plain(output).trimEnd();
        if (trimmed) return trimmed.slice(0, 4000);
        if (exitCode === 0) return '(no output)';
        return `error: command exited with code ${exitCode}`;
      } catch (error: any) {
        return `error: ${plain(error.message)}`;
      }
    }
  })
};

async function submit() {
  if (busy) return;

  const raw = inputChars.join('');
  const trimmed = raw.trim();
  inputChars.length = 0;
  cursor = 0;
  scrollOffset = 0;
  render();

  if (!trimmed) return;
  if (trimmed === '/exit') {
    cleanup(0);
    return;
  }

  if (trimmed.startsWith('!')) {
    persistEntry('shell', trimmed.slice(1).trimStart());
    await runShell(trimmed.slice(1));
    return;
  }

  persistEntry('user', trimmed);

  busy = true;
  liveAssistantText = '';
  abortController = new AbortController();
  render();

  try {
    messages.push({ role: 'user', content: await expand(trimmed) });
    const result = streamText({
      model: openai(MODEL),
      messages,
      tools,
      stopWhen: stepCountIs(20),
      abortSignal: abortController.signal
    });

    for await (const chunk of result.textStream) {
      liveAssistantText += chunk;
      render();
    }

    const [response, usage] = await Promise.all([result.response, result.usage]);
    messages.push(...response.messages);
    lastPromptTokens = usage.inputTokens || 0;
    const price = calcPrice({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, MODEL, { providerId: 'openai' });
    if (price) totalCost += price.total_price;
    persistEntry('assistant', liveAssistantText);
  } catch (error: any) {
    if (abortController?.signal.aborted) {
      if (liveAssistantText.trim()) persistEntry('assistant', liveAssistantText);
      persistEntry('meta', 'cancelled');
    } else {
      if (liveAssistantText.trim()) persistEntry('assistant', liveAssistantText);
      persistEntry('error', plain(error.message));
    }
  } finally {
    liveAssistantText = '';
    abortController = null;
    busy = false;
    render();
  }
}

function insertText(text: string) {
  if (!text || busy) return;
  const chars = Array.from(text);
  inputChars.splice(cursor, 0, ...chars);
  cursor += chars.length;
  if (currentMentionQuery() === null) selectedSuggestion = 0;
  render();
}

function cleanup(code = 0) {
  if (closed) return;
  closed = true;

  clearInterval(spinnerTimer);
  process.stdout.off('resize', render);
  process.stdin.off('keypress', onKeypress);

  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  log.clear();
  log.done();
  process.exit(code);
}

async function onKeypress(str: string, key: { ctrl?: boolean; meta?: boolean; name?: string }) {
  if (key.ctrl && key.name === 'c') {
    cleanup(0);
    return;
  }

  if (key.name === 'escape' && busy && abortController) {
    abortController.abort();
    return;
  }

  if (key.name === 'return') {
    if (acceptSuggestion()) return;
    await submit();
    return;
  }

  if (busy) return;

  if (key.name === 'up') {
    if (moveSuggestionSelection(-1)) return;
  }

  if (key.name === 'down') {
    if (moveSuggestionSelection(1)) return;
  }

  if (key.name === 'backspace') {
    if (cursor > 0) {
      inputChars.splice(cursor - 1, 1);
      cursor -= 1;
      if (currentMentionQuery() === null) selectedSuggestion = 0;
      render();
    }
    return;
  }

  if (key.name === 'delete') {
    if (cursor < inputChars.length) {
      inputChars.splice(cursor, 1);
      if (currentMentionQuery() === null) selectedSuggestion = 0;
      render();
    }
    return;
  }

  if (key.name === 'left') {
    cursor = Math.max(0, cursor - 1);
    render();
    return;
  }

  if (key.name === 'right') {
    cursor = Math.min(inputChars.length, cursor + 1);
    render();
    return;
  }

  if (key.name === 'home') {
    cursor = 0;
    render();
    return;
  }

  if (key.name === 'end') {
    cursor = inputChars.length;
    render();
    return;
  }

  if (!key.ctrl && !key.meta && str) insertText(str);
}

const spinnerTimer = setInterval(() => {
  if (!busy || closed) return;
  render();
}, 80);
spinnerTimer.unref();

function seedHistory() {
  if (historyBlocks.length > 0) return;
}

installSegmentContainingPolyfill();
process.on('SIGINT', () => cleanup(0));
process.on('uncaughtException', error => {
  log.clear();
  process.stderr.write(`${plain(error.stack || error.message)}\n`);
  cleanup(1);
});
process.on('unhandledRejection', error => {
  log.clear();
  process.stderr.write(`${plain(String(error))}\n`);
  cleanup(1);
});

async function main() {
  await syncTheme();

  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', onKeypress);
  process.stdout.on('resize', render);

  seedHistory();
  render();
}

main().catch(error => {
  log.clear();
  process.stderr.write(`${plain(error instanceof Error ? error.stack || error.message : String(error))}\n`);
  cleanup(1);
});
