import { streamText, stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { calcPrice } from '@pydantic/genai-prices';
import { readFile } from 'node:fs/promises';
import { emitKeypressEvents } from 'node:readline';
import { createLogUpdate } from 'log-update';
import ora from 'ora';

import { acceptSuggestion, currentMentionQuery, listMentionSuggestions } from './composer';
import { MODEL } from '@/config';
import { frameWidth, renderComposer, renderEntry, renderFooter, renderHeader, renderOutputPreview, renderSuggestions } from './render';
import { runUserShell } from './shell';
import { createAgentStore } from '@/store';
import { plain, installSegmentContainingPolyfill, wrapText } from './text';
import { createTheme } from './theme';
import { createTools } from '@/tools';
import { EntryKind, type Keypress, type LogUpdate } from './types';

export class AgentApp {
  private readonly store = createAgentStore();
  private readonly theme = createTheme();
  private readonly spinner = ora({ spinner: 'dots10', color: 'green', isEnabled: false });
  private readonly log = createLogUpdate(process.stdout, {
    showCursor: false,
    defaultWidth: 100,
    defaultHeight: 30
  }) as LogUpdate;
  private readonly tools = createTools({
    persistEntry: (kind, text) => this.persistEntry(kind, text),
    runUserShell
  });
  private readonly spinnerTimer: ReturnType<typeof setInterval>;

  private get state() {
    return this.store.getState();
  }

  constructor() {
    this.spinnerTimer = setInterval(() => {
      if (!this.state.busy || this.state.closed) return;
      this.render();
    }, 80);
    this.spinnerTimer.unref();
    installSegmentContainingPolyfill();
  }

  async start() {
    this.theme.sync();

    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.onKeypress);
    process.stdout.on('resize', this.render);

    this.render();
  }

  cleanup(code = 0) {
    if (this.state.closed) return;
    this.store.setClosed();

    clearInterval(this.spinnerTimer);
    process.stdout.off('resize', this.render);
    process.stdin.off('keypress', this.onKeypress);

    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    this.log.clear();
    this.log.done();
    process.exit(code);
  }

  handleFatalError(error: unknown, code = 1) {
    this.log.clear();
    process.stderr.write(`${plain(error instanceof Error ? error.stack || error.message : String(error))}\n`);
    this.cleanup(code);
  }

  private getSuggestions() {
    return listMentionSuggestions(this.state.inputChars, this.state.cursor);
  }

  private normalizeSuggestions() {
    const suggestions = this.getSuggestions();

    if (suggestions.length === 0) {
      this.store.resetSelectedSuggestion();
      return suggestions;
    }

    this.store.setSelectedSuggestion(Math.max(0, Math.min(this.state.selectedSuggestion, suggestions.length - 1)));
    return suggestions;
  }

  private render = () => {
    if (this.state.closed) return;

    const suggestions = this.normalizeSuggestions();
    const header = renderHeader(this.theme);
    const transcript = this.state.historyBlocks.flat();
    const preview = renderOutputPreview(this.state, this.theme);
    const composer = renderComposer(this.state, this.theme);
    const suggestionLines = renderSuggestions(this.theme, suggestions, this.state.selectedSuggestion);
    const footer = renderFooter(this.state, this.theme, this.spinner.frame().trim());
    const rows = process.stdout.rows || 30;
    const reserved = header.length + composer.length + suggestionLines.length + footer.length;
    const available = Math.max(0, rows - reserved);
    const body = [...transcript, ...preview].slice(-available);

    this.log([...header, ...body, ...composer, ...suggestionLines, ...footer].join('\n'));
  };

  private pushHistory(lines: string[]) {
    this.store.pushHistory(lines);
  }

  private persistEntry(kind: EntryKind, text: string) {
    if (!text.trim()) return;
    this.pushHistory(renderEntry(kind, text, this.theme, frameWidth()));
    this.render();
  }

  private persistPlain(text: string) {
    if (!text.trim()) return;
    this.pushHistory(wrapText(text, frameWidth()).map(line => ` ${line}`));
    this.render();
  }

  private persistAnsi(text: string) {
    if (!text.trim()) return;
    this.pushHistory(text.split('\n').map(line => ` ${line}`));
    this.render();
  }

  private async expand(input: string) {
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

  private async runShellCommand(cmd: string) {
    this.store.setBusy(true);
    this.render();

    try {
      const { output, exitCode } = await runUserShell(cmd);
      const trimmed = output.trimEnd();

      if (trimmed) this.persistAnsi(trimmed);
      else if (exitCode === 0) this.persistPlain('(no output)');
      else this.persistEntry(EntryKind.Error, `command exited with code ${exitCode}`);
    } catch (error: unknown) {
      this.persistEntry(EntryKind.Error, plain(error instanceof Error ? error.message : String(error)));
    } finally {
      this.store.setBusy(false);
      this.render();
    }
  }

  private async submit() {
    if (this.state.busy) return;

    const raw = this.state.inputChars.join('');
    const trimmed = raw.trim();
    this.store.resetComposer();
    this.render();

    if (!trimmed) return;
    if (trimmed === '/exit') {
      this.cleanup(0);
      return;
    }

    if (trimmed.startsWith('!')) {
      this.persistEntry(EntryKind.Shell, trimmed.slice(1).trimStart());
      await this.runShellCommand(trimmed.slice(1));
      return;
    }

    this.persistEntry(EntryKind.User, trimmed);

    this.store.setBusy(true);
    this.store.clearLiveAssistantText();
    this.store.setAbortController(new AbortController());
    this.render();

    try {
      this.store.pushMessage({ role: 'user', content: await this.expand(trimmed) });
      const result = streamText({
        model: openai(MODEL),
        messages: this.state.messages,
        tools: this.tools,
        stopWhen: stepCountIs(20),
        abortSignal: this.state.abortController.signal
      });

      for await (const chunk of result.textStream) {
        this.store.appendLiveAssistantText(chunk);
        this.render();
      }

      const [response, usage] = await Promise.all([result.response, result.usage]);
      this.store.pushMessages(response.messages);
      this.store.setLastPromptTokens(usage.inputTokens || 0);

      const price = calcPrice({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, MODEL, { providerId: 'openai' });

      if (price) this.store.addTotalCost(price.total_price);
      this.persistEntry(EntryKind.Assistant, this.state.liveAssistantText);
    } catch (error: unknown) {
      if (this.state.abortController?.signal.aborted) {
        if (this.state.liveAssistantText.trim()) this.persistEntry(EntryKind.Assistant, this.state.liveAssistantText);
        this.persistEntry(EntryKind.Meta, 'cancelled');
      } else {
        if (this.state.liveAssistantText.trim()) this.persistEntry(EntryKind.Assistant, this.state.liveAssistantText);
        this.persistEntry(EntryKind.Error, plain(error instanceof Error ? error.message : String(error)));
      }
    } finally {
      this.store.clearLiveAssistantText();
      this.store.setAbortController(null);
      this.store.setBusy(false);
      this.render();
    }
  }

  private insertText(text: string) {
    if (!text || this.state.busy) return;

    this.store.insertText(text);

    if (currentMentionQuery(this.state.inputChars, this.state.cursor) === null) {
      this.store.resetSelectedSuggestion();
    }

    this.render();
  }

  private moveSuggestionSelection(delta: number) {
    const suggestions = this.getSuggestions();
    if (suggestions.length === 0) return false;

    this.store.setSelectedSuggestion((this.state.selectedSuggestion + delta + suggestions.length) % suggestions.length);
    this.render();
    return true;
  }

  private tryAcceptSuggestion() {
    const suggestions = this.normalizeSuggestions();
    const accepted = acceptSuggestion(this.store, suggestions);
    if (!accepted) return false;

    this.store.setScrollOffset(0);
    this.store.resetSelectedSuggestion();
    this.render();
    return true;
  }

  private onKeypress = async (str: string, key: Keypress) => {
    if (key.ctrl && key.name === 'c') {
      this.cleanup(0);
      return;
    }

    if (key.name === 'escape' && this.state.busy && this.state.abortController) {
      this.state.abortController.abort();
      return;
    }

    if (key.name === 'return') {
      if (this.tryAcceptSuggestion()) return;
      await this.submit();
      return;
    }

    if (this.state.busy) return;

    if (key.name === 'up' && this.moveSuggestionSelection(-1)) return;
    if (key.name === 'down' && this.moveSuggestionSelection(1)) return;

    if (key.name === 'backspace') {
      if (this.store.deleteBackward()) {
        if (currentMentionQuery(this.state.inputChars, this.state.cursor) === null) {
          this.store.resetSelectedSuggestion();
        }

        this.render();
      }
      return;
    }

    if (key.name === 'delete') {
      if (this.store.deleteForward()) {
        if (currentMentionQuery(this.state.inputChars, this.state.cursor) === null) {
          this.store.resetSelectedSuggestion();
        }

        this.render();
      }
      return;
    }

    if (key.name === 'left') {
      this.store.setCursor(this.state.cursor - 1);
      this.render();
      return;
    }

    if (key.name === 'right') {
      this.store.setCursor(this.state.cursor + 1);
      this.render();
      return;
    }

    if (key.name === 'home') {
      this.store.setCursor(0);
      this.render();
      return;
    }

    if (key.name === 'end') {
      this.store.setCursor(this.state.inputChars.length);
      this.render();
      return;
    }

    if (!key.ctrl && !key.meta && str) this.insertText(str);
  };
}
