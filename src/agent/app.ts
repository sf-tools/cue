import ora from 'ora';
import { openai } from '@ai-sdk/openai';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { streamText, stepCountIs } from 'ai';
import { createLogUpdate } from 'log-update';
import { calcPrice } from '@pydantic/genai-prices';

import { MODEL } from '@/config';
import { createTheme } from '@/theme';
import { createTools } from '@/tools';
import { runUserShell } from './shell';
import { createAgentStore } from '@/store';
import { plain, installSegmentContainingPolyfill } from '@/text';
import { EntryKind, type LogUpdate } from '@/types';
import { handleAbortKeypress, createAbortController, resetAbortState } from './abort';
import { createFailedToolEntry, createPendingToolEntry, createCompletedToolEntry } from './tool-history';
import { resolveInputBinding } from './keybinds';
import { acceptSuggestion, currentMentionQuery, listMentionSuggestions } from './mentions';
import { createRenderContext, renderHeader, renderScreen, serializeBlock, type Frame } from '@/render';

export class AgentApp {
  private readonly store = createAgentStore();
  private readonly theme = createTheme();
  private readonly spinner = ora({ spinner: 'dots10', color: 'green', isEnabled: false });

  private readonly log = createLogUpdate(process.stdout, {
    showCursor: false,
    defaultWidth: 100,
    defaultHeight: 30
  }) as LogUpdate;

  private readonly tools = createTools({ runUserShell });

  private readonly spinnerTimer: ReturnType<typeof setInterval>;
  private readonly sessionId = randomUUID();
  private previousFrame: Frame | null = null;
  private drainingQueuedSubmissions = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private renderScheduled = false;
  private lastRenderAt = 0;
  private historyNavigationIndex: number | null = null;
  private historyNavigationDraft = '';

  private get state() {
    return this.store.getState();
  }

  constructor() {
    this.spinnerTimer = setInterval(() => {
      if (!this.state.busy || this.state.closed) return;
      this.scheduleRender();
    }, 80);
    this.spinnerTimer.unref();
    installSegmentContainingPolyfill();
  }

  async start() {
    this.theme.sync();

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.onStdinData);
    process.stdout.on('resize', this.render);

    this.render();
  }

  cleanup(code = 0) {
    if (this.state.closed) return;
    this.store.setClosed();

    clearInterval(this.spinnerTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    process.stdout.off('resize', this.render);
    process.stdin.off('data', this.onStdinData);

    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    this.log.clear();
    this.log.done();

    if (code === 0) {
      const ctx = createRenderContext(this.theme, this.spinner.frame().trim());
      const header = serializeBlock(renderHeader(ctx)).join('\n');
      // TODO: wire this in
      process.stdout.write(`${header}\n To resume this session: cue --resume=${this.sessionId}\n\n`);
    }

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

  private performRender = () => {
    this.renderScheduled = false;
    this.renderTimer = null;

    if (this.state.closed) return;

    const suggestions = this.normalizeSuggestions();
    const ctx = createRenderContext(this.theme, this.spinner.frame().trim());
    const { frame, diff, nextScrollOffset } = renderScreen(this.state, ctx, suggestions, this.previousFrame);

    if (nextScrollOffset !== this.state.scrollOffset) this.store.setScrollOffset(nextScrollOffset);
    if (!diff.changed) return;

    this.log(frame.lines.join('\n'));
    this.previousFrame = frame;
    this.lastRenderAt = Date.now();
  };

  private scheduleRender() {
    if (this.state.closed || this.renderScheduled) return;

    const delay = Math.max(0, 16 - (Date.now() - this.lastRenderAt));
    this.renderScheduled = true;
    this.renderTimer = setTimeout(this.performRender, delay);
    this.renderTimer.unref?.();
  }

  private render = () => {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
      this.renderScheduled = false;
    }

    this.performRender();
  };

  private persistEntry(kind: EntryKind, text: string) {
    if (!text.trim()) return;
    this.store.pushHistoryEntry({ type: 'entry', kind, text });
    this.render();
  }

  private persistPlain(text: string) {
    if (!text.trim()) return;
    this.store.pushHistoryEntry({ type: 'plain', text });
    this.render();
  }

  private persistAnsi(text: string) {
    if (!text.trim()) return;
    this.store.pushHistoryEntry({ type: 'ansi', text });
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
      void this.drainQueuedSubmissions();
    }
  }

  private async drainQueuedSubmissions() {
    if (this.drainingQueuedSubmissions || this.state.closed) return;

    this.drainingQueuedSubmissions = true;

    try {
      while (!this.state.closed && !this.state.busy) {
        const next = this.store.shiftQueuedSubmission();
        if (!next) break;

        this.render();
        await this.processSubmission(next);
      }
    } finally {
      this.drainingQueuedSubmissions = false;
    }
  }

  private async processSubmission(raw: string) {
    const trimmed = raw.trim();

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

    const abortController = createAbortController(this.store);

    this.store.setBusy(true);
    this.store.clearLiveAssistantText();
    this.render();

    try {
      this.store.pushMessage({ role: 'user', content: await this.expand(trimmed) });
      const result = streamText({
        model: openai(MODEL),
        messages: this.state.messages,
        tools: this.tools,
        stopWhen: stepCountIs(20),
        abortSignal: abortController.signal
      });

      for await (const part of result.fullStream) {
        if (abortController.signal.aborted) break;
        if (this.state.abortRequested && part.type !== 'abort' && part.type !== 'error') continue;

        switch (part.type) {
          case 'abort':
            abortController.signal.throwIfAborted();
            break;
          case 'text-delta':
            this.store.appendLiveAssistantText(part.text);
            this.scheduleRender();
            break;
          case 'tool-call':
            this.store.upsertToolEntry(createPendingToolEntry(part));
            this.scheduleRender();
            break;
          case 'tool-result':
            if (part.preliminary) break;
            this.store.upsertToolEntry(createCompletedToolEntry(part));
            this.scheduleRender();
            break;
          case 'tool-error':
            this.store.upsertToolEntry(createFailedToolEntry(part));
            this.scheduleRender();
            break;
        }
      }

      abortController.signal.throwIfAborted();

      const [response, usage] = await Promise.all([result.response, result.usage]);
      this.store.pushMessages(response.messages);
      this.store.setLastPromptTokens(usage.inputTokens || 0);

      const price = calcPrice({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, MODEL, { providerId: 'openai' });

      if (price) this.store.addTotalCost(price.total_price);
      this.persistEntry(EntryKind.Assistant, this.state.liveAssistantText);
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        if (this.state.liveAssistantText.trim()) this.persistEntry(EntryKind.Assistant, this.state.liveAssistantText);
        this.persistEntry(EntryKind.Meta, '(aborted)');
      } else {
        if (this.state.liveAssistantText.trim()) this.persistEntry(EntryKind.Assistant, this.state.liveAssistantText);
        this.persistEntry(EntryKind.Error, plain(error instanceof Error ? error.message : String(error)));
      }
    } finally {
      this.store.clearLiveAssistantText();
      this.store.setAbortController(null);
      resetAbortState(this.store);
      this.store.setBusy(false);
      this.render();
      void this.drainQueuedSubmissions();
    }
  }

  private clearHistoryNavigation() {
    this.historyNavigationIndex = null;
    this.historyNavigationDraft = '';
  }

  private getInputHistory() {
    return this.state.historyEntries.flatMap(entry => (entry.type === 'entry' && entry.kind === EntryKind.User ? [entry.text] : []));
  }

  private moveInputHistory(delta: number) {
    const history = this.getInputHistory();
    if (history.length === 0) return false;

    if (delta < 0) {
      if (this.historyNavigationIndex === null) {
        this.historyNavigationDraft = this.state.inputChars.join('');
        this.historyNavigationIndex = history.length - 1;
      } else {
        this.historyNavigationIndex = Math.max(0, this.historyNavigationIndex - 1);
      }

      this.store.replaceInput(history[this.historyNavigationIndex]);
      this.store.resetSelectedSuggestion();
      this.render();
      return true;
    }

    if (this.historyNavigationIndex === null) return false;

    const nextIndex = this.historyNavigationIndex + 1;
    if (nextIndex >= history.length) {
      const draft = this.historyNavigationDraft;
      this.clearHistoryNavigation();
      this.store.replaceInput(draft);
    } else {
      this.historyNavigationIndex = nextIndex;
      this.store.replaceInput(history[nextIndex]);
    }

    this.store.resetSelectedSuggestion();
    this.render();
    return true;
  }

  private async submit() {
    const raw = this.state.inputChars.join('');
    const trimmed = raw.trim();
    this.clearHistoryNavigation();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.render();

    if (!trimmed) return;

    if (this.state.busy || this.state.queuedSubmissions.length > 0 || this.drainingQueuedSubmissions) {
      this.store.enqueueSubmission(raw);
      this.render();
      void this.drainQueuedSubmissions();
      return;
    }

    await this.processSubmission(raw);
  }

  private insertText(text: string) {
    if (!text) return;
    this.historyNavigationIndex = null;
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

  private handleEscape() {
    if (handleAbortKeypress(this.store)) {
      this.render();
      return;
    }

    if (this.state.inputChars.length === 0 && this.state.selectedSuggestion === 0) return;
    this.clearHistoryNavigation();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.render();
  }

  private handleDelete(backward: boolean) {
    const changed = backward ? this.store.deleteBackward() : this.store.deleteForward();
    if (!changed) return;

    this.historyNavigationIndex = null;

    if (currentMentionQuery(this.state.inputChars, this.state.cursor) === null) this.store.resetSelectedSuggestion();
    this.render();
  }

  private onInputBinding = async (chunk: Buffer | string) => {
    const binding = resolveInputBinding(chunk);
    if (!binding) return;

    if (binding.type === 'interrupt') {
      this.cleanup(0);
      return;
    }

    if (binding.type === 'escape') {
      this.handleEscape();
      return;
    }

    if (this.state.abortConfirmationPending) {
      this.store.setAbortConfirmationPending(false);
      this.render();
    }

    if (binding.type === 'acceptSuggestion') {
      this.tryAcceptSuggestion();
      return;
    }

    if (binding.type === 'submit') {
      if (this.tryAcceptSuggestion()) return;
      await this.submit();
      return;
    }

    switch (binding.type) {
      case 'moveSuggestion': {
        if (this.moveSuggestionSelection(binding.delta)) return;
        this.moveInputHistory(binding.delta);
        return;
      }
      case 'backspace':
        this.handleDelete(true);
        return;
      case 'delete':
        this.handleDelete(false);
        return;
      case 'moveCursor':
        this.store.setCursor(this.state.cursor + binding.delta);
        this.render();
        return;
      case 'cursorHome':
        this.store.setCursor(0);
        this.render();
        return;
      case 'cursorEnd':
        this.store.setCursor(this.state.inputChars.length);
        this.render();
        return;
      case 'insertText':
        this.insertText(binding.text);
        return;
      default:
        return;
    }
  };

  private onStdinData = (chunk: Buffer | string) => {
    void this.onInputBinding(chunk);
  };
}
