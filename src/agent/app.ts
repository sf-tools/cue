import chalk from 'chalk';
import ora from 'ora';
import {
  createOpenAIProviderOptions,
  cycleThinkingMode,
  getCompactionTriggerTokens,
  loadCuePreferences,
  pricingUsageFromLanguageModelUsage,
  saveCuePreferences
} from '@/config';
import { previewFileChangesForToolCall } from '@/file-changes';
import { createTheme } from '@/theme';
import { createTools } from '@/tools';
import { runUserShell } from './shell';
import { openai } from '@ai-sdk/openai';
import { randomUUID } from 'node:crypto';
import { refreshGitBranch } from '@/git';
import { createAgentStore, type AgentState, type AgentStore } from '@/store';
import { readFile } from 'node:fs/promises';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { resolveInputBinding } from './keybinds';
import { calcPrice } from '@pydantic/genai-prices';
import { EntryKind, type ApprovalDecision, type ApprovalRequest, type ApprovalScope, type HistoryEntry } from '@/types';
import { normalizePtyOutput, plain, installSegmentContainingPolyfill } from '@/text';
import { compactMessages, canCompactMessages } from './compact';
import { builtinSlashCommands, createSlashCommandRegistry } from './slash-commands';
import { handleAbortKeypress, createAbortController, resetAbortState } from './abort';
import { takeOverEarlyStdin } from './early-stdin';
import { acceptComposerSuggestion, listComposerSuggestions } from './composer-suggestions';
import { startMentionIndex } from './mention-index';
import { createRenderContext, frameWidth, renderHeader, serializeBlock } from '@/render';
import { blankLine, vstack } from '@/render/primitives';
import { renderComposer, moveComposerCursorVertical } from '@/render/components/composer';
import { renderFooter } from '@/render/components/footer';
import { renderSuggestions } from '@/render/components/suggestions';
import { renderOutputPreview } from '@/render/components/transcript';
import type { ReadStream as TtyReadStream } from 'node:tty';
import { renderQueuedSubmissions } from '@/render/components/queued';
import { renderHistoryEntry } from '@/render/components/entry';
import { createFailedToolEntry, createPendingToolEntry, createCompletedToolEntry } from './tool-history';

const RAINBOW_PHRASE_PATTERN = /you'?re absolutely right/i;
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';

function bracketedPasteSuffixLength(text: string) {
  const maxLength = Math.min(text.length, BRACKETED_PASTE_START.length - 1);

  for (let length = maxLength; length > 1; length -= 1) {
    if (BRACKETED_PASTE_START.startsWith(text.slice(-length))) return length;
  }

  return 0;
}

function sameLines(left: string[], right: string[]) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function estimateTokenCount(text: string) {
  return Math.max(0, Math.ceil(Array.from(text).length / 4));
}

function estimateValueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTokenCount(value);
  if (Array.isArray(value)) return value.reduce((sum, part) => sum + estimateValueTokens(part), 0);
  if (value == null) return 0;

  try {
    return estimateTokenCount(JSON.stringify(value));
  } catch {
    return estimateTokenCount(String(value));
  }
}

function estimateMessageTokens(messages: ModelMessage[]) {
  return messages.reduce((sum, message) => sum + estimateValueTokens(message.content), 0);
}

export class AgentApp {
  private readonly store: AgentStore = createAgentStore();
  private readonly theme = createTheme();
  private readonly spinner = ora({ spinner: 'dots10', color: 'green', isEnabled: false });
  private readonly commandSpinner = ora({ spinner: 'dots3', color: 'yellow', isEnabled: false });

  private transientLineCount = 0;
  private committedHistoryCount = 0;
  private headerPrinted = false;
  private lastTransientLines: string[] = [];

  private readonly tools = createTools({
    runUserShell,
    requestApproval: request => this.requestApproval(request),
    getCurrentModel: () => this.state.currentModel,
    getThinkingMode: () => this.state.thinkingMode
  });
  private readonly slashCommands = createSlashCommandRegistry(builtinSlashCommands);

  private readonly spinnerTimer: ReturnType<typeof setInterval>;
  private readonly rainbowTimer: ReturnType<typeof setInterval>;
  private readonly sessionId = randomUUID();
  private drainingQueuedSubmissions = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private footerNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private renderScheduled = false;
  private lastRenderAt = 0;
  private historyNavigationIndex: number | null = null;
  private historyNavigationDraft = '';
  private preferredComposerColumn: number | null = null;
  private pendingApprovalResolver: ((decision: ApprovalDecision) => void) | null = null;
  private stdin: TtyReadStream = process.stdin;
  private bracketedPasteActive = false;
  private bracketedPasteBuffer = '';
  private stdinBuffer = '';

  private clearTransientBlock() {
    if (this.transientLineCount <= 0) {
      this.lastTransientLines = [];
      return;
    }

    if (!process.stdout.isTTY) {
      this.transientLineCount = 0;
      this.lastTransientLines = [];
      return;
    }

    if (this.transientLineCount > 1) process.stdout.write(`\u001b[${this.transientLineCount - 1}F`);
    else process.stdout.write('\r');

    for (let index = 0; index < this.transientLineCount; index += 1) {
      process.stdout.write('\u001b[2K\r');
      if (index < this.transientLineCount - 1) process.stdout.write('\u001b[E');
    }

    if (this.transientLineCount > 1) process.stdout.write(`\u001b[${this.transientLineCount - 1}F`);
    this.transientLineCount = 0;
    this.lastTransientLines = [];
  }

  private redrawTransientLines(lines: string[]) {
    this.clearTransientBlock();
    if (lines.length === 0) return;

    process.stdout.write(lines.join('\n'));
    this.transientLineCount = lines.length;
    this.lastTransientLines = [...lines];
  }

  private patchTransientLines(lines: string[]) {
    if (!process.stdout.isTTY || this.transientLineCount === 0 || this.lastTransientLines.length !== lines.length) {
      this.redrawTransientLines(lines);
      return;
    }

    const changedRows = lines.flatMap((line, index) => (line === this.lastTransientLines[index] ? [] : [index]));
    if (changedRows.length === 0) return;

    if (this.transientLineCount > 1) process.stdout.write(`\u001b[${this.transientLineCount - 1}F`);
    else process.stdout.write('\r');

    let currentRow = 0;

    for (const row of changedRows) {
      const delta = row - currentRow;
      if (delta > 0) process.stdout.write(`\u001b[${delta}E`);
      else if (delta < 0) process.stdout.write(`\u001b[${-delta}F`);

      process.stdout.write('\u001b[2K\r');
      if (lines[row]) process.stdout.write(lines[row]);
      currentRow = row;
    }

    const lastRow = lines.length - 1;
    const delta = lastRow - currentRow;
    if (delta > 0) process.stdout.write(`\u001b[${delta}E`);
    else if (delta < 0) process.stdout.write(`\u001b[${-delta}F`);
    process.stdout.write('\r');

    this.lastTransientLines = [...lines];
  }

  private drawTransientLines(lines: string[]) {
    if (sameLines(lines, this.lastTransientLines)) return;

    if (this.lastTransientLines.length === 0 || this.transientLineCount === 0) {
      this.redrawTransientLines(lines);
      return;
    }

    this.patchTransientLines(lines);
  }

  private appendPermanentLines(lines: string[]) {
    if (lines.length === 0) return;
    this.clearTransientBlock();
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  private getAnimatedAssistantIndex() {
    for (let index = this.state.historyEntries.length - 1; index >= 0; index -= 1) {
      const entry = this.state.historyEntries[index];
      if (entry.type !== 'entry') continue;
      if (entry.kind === EntryKind.User) return null;
      if (entry.kind === EntryKind.Assistant) return RAINBOW_PHRASE_PATTERN.test(entry.text) ? index : null;
    }

    return null;
  }

  private flushCommittedHistory(ctx: ReturnType<typeof createRenderContext>) {
    const lines: string[] = [];
    const animatedAssistantIndex = this.getAnimatedAssistantIndex();

    while (this.committedHistoryCount < this.state.historyEntries.length) {
      const index = this.committedHistoryCount;
      const entry = this.state.historyEntries[index];
      if (entry.type === 'tool' && entry.status === 'running') break;
      if (index === animatedAssistantIndex) break;

      lines.push(...serializeBlock(renderHistoryEntry(entry, ctx)), '');
      this.committedHistoryCount += 1;
    }

    this.appendPermanentLines(lines);
  }

  private renderTransientLines(ctx: ReturnType<typeof createRenderContext>, suggestions: ReturnType<AgentApp['normalizeSuggestions']>) {
    const animatedAssistantIndex = this.getAnimatedAssistantIndex();
    const pendingHistory = this.state.historyEntries.slice(this.committedHistoryCount).flatMap((entry, offset) => {
      const index = this.committedHistoryCount + offset;
      return [...renderHistoryEntry(entry, ctx, { animateAssistant: index === animatedAssistantIndex }), blankLine()];
    });
    const preview = renderOutputPreview(this.state.liveReasoningText, this.state.liveAssistantText, ctx, this.state.pendingApproval);
    const queued = renderQueuedSubmissions(this.state.queuedSubmissions, ctx, 8);
    const composer = renderComposer(
      {
        inputChars: this.state.inputChars,
        pasteRanges: this.state.pasteRanges,
        cursor: this.state.cursor,
        slashCommandLength: this.getSlashCommandLength(),
        showCapabilitiesHint: this.state.historyEntries.length === 0
      },
      ctx
    ).block;
    const suggestionLines = renderSuggestions(suggestions, this.state.selectedSuggestion, ctx);
    const footer = renderFooter(this.state, ctx);

    const topSections = [pendingHistory, preview, queued].filter(section => section.length > 0);
    const body = topSections.flatMap((section, index) => (index === 0 ? section : [blankLine(), ...section]));
    const blocks = body.length > 0 ? [body, [blankLine()], composer, suggestionLines, footer] : [composer, suggestionLines, footer];

    return serializeBlock(vstack(...blocks));
  }

  private get state() {
    return this.store.getState();
  }

  constructor() {
    this.spinnerTimer = setInterval(() => {
      if (!this.state.busy || this.state.closed) return;
      this.scheduleRender();
    }, 80);
    this.spinnerTimer.unref();

    this.rainbowTimer = setInterval(() => {
      if (this.state.closed || !this.hasRainbowPhraseVisible()) return;
      this.scheduleRender();
    }, 33);
    this.rainbowTimer.unref();

    installSegmentContainingPolyfill();
  }

  async start() {
    await this.theme.sync();
    await refreshGitBranch(process.cwd());
    startMentionIndex(process.cwd());

    const preferences = await loadCuePreferences();
    this.store.setCurrentModel(preferences.model);
    this.store.setThinkingMode(preferences.reasoning);
    this.store.setAutoCompactEnabled(preferences.autoCompactEnabled);

    const { stream, buffer } = takeOverEarlyStdin();
    this.stdin = stream ?? process.stdin;

    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    if (process.stdout.isTTY) process.stdout.write('\u001b[?25l\u001b[?2004h');
    this.stdin.resume();
    this.stdin.on('data', this.onStdinData);
    process.stdout.on('resize', this.render);

    this.render();
    for (const chunk of buffer) this.onStdinData(chunk);
  }

  cleanup(code = 0) {
    if (this.state.closed) return;
    this.store.setClosed();

    clearInterval(this.spinnerTimer);
    clearInterval(this.rainbowTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.footerNoticeTimer) clearTimeout(this.footerNoticeTimer);
    process.stdout.off('resize', this.render);
    this.stdin.off('data', this.onStdinData);

    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
    this.clearTransientBlock();
    if (process.stdout.isTTY) process.stdout.write('\u001b[?25h\u001b[?2004l');

    if (code === 0) {
      const ctx = createRenderContext(this.theme, this.spinner.frame().trim(), this.commandSpinner.frame().trim());
      const header = serializeBlock(renderHeader(ctx)).join('\n');

      if (process.stdout.isTTY) process.stdout.write('\u001b[3J\u001b[2J\u001b[H');
      process.stdout.write(`${header}\n`);
      if (this.hasResumableSession()) {
        process.stdout.write(` ${chalk.white('To resume this session:')} ${chalk.cyan('cue --resume=')}${chalk.cyanBright(this.sessionId)}\n`);
      }
    }

    process.exit(code);
  }

  handleFatalError(error: unknown, code = 1) {
    this.clearTransientBlock();
    if (process.stdout.isTTY) process.stdout.write('\u001b[?25h');
    process.stderr.write(`${plain(error instanceof Error ? error.stack || error.message : String(error))}\n`);
    this.cleanup(code);
  }

  private getSuggestions() {
    return listComposerSuggestions(this.state.inputChars, this.state.cursor, this.slashCommands, {
      currentModel: this.state.currentModel,
      thinkingMode: this.state.thinkingMode
    });
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

  private getCurrentSlashCommand() {
    return this.slashCommands.parse(this.state.inputChars.join(''));
  }

  private getSlashCommandLength() {
    const parsed = this.getCurrentSlashCommand();
    return parsed?.type === 'resolved' ? parsed.invocation.length : 0;
  }

  private performRender = () => {
    this.renderScheduled = false;
    this.renderTimer = null;

    if (this.state.closed) return;

    const suggestions = this.normalizeSuggestions();
    const ctx = createRenderContext(this.theme, this.spinner.frame().trim(), this.commandSpinner.frame().trim());

    if (!this.headerPrinted) {
      this.appendPermanentLines(serializeBlock(renderHeader(ctx)));
      this.headerPrinted = true;
    }

    this.flushCommittedHistory(ctx);
    this.drawTransientLines(this.renderTransientLines(ctx, suggestions));
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

  private hasResumableSession() {
    return this.state.historyEntries.length > 0;
  }

  private shouldConfirmExit() {
    return this.hasResumableSession();
  }

  private hasRainbowPhraseVisible() {
    return RAINBOW_PHRASE_PATTERN.test(this.state.liveAssistantText) || this.getAnimatedAssistantIndex() !== null;
  }

  private showFooterNotice(text: string, durationMs = 2_000) {
    if (this.footerNoticeTimer) clearTimeout(this.footerNoticeTimer);

    this.store.setFooterNotice(text);
    this.render();

    this.footerNoticeTimer = setTimeout(() => {
      this.footerNoticeTimer = null;
      if (this.state.closed || this.state.footerNotice !== text) return;
      this.store.setFooterNotice(null);
      this.render();
    }, durationMs);
    this.footerNoticeTimer.unref?.();
  }

  private persistPreferences() {
    void saveCuePreferences({
      model: this.state.currentModel,
      reasoning: this.state.thinkingMode,
      autoCompactEnabled: this.state.autoCompactEnabled
    });
  }

  private setCurrentModel(model: string) {
    this.store.setCurrentModel(model);
    this.store.resetLastUsage();
    this.persistPreferences();
    this.render();
  }

  private setThinkingMode(thinkingMode: AgentState['thinkingMode']) {
    this.store.setThinkingMode(thinkingMode);
    this.persistPreferences();
    this.render();
  }

  private setAutoCompactEnabled(enabled: boolean) {
    this.store.setAutoCompactEnabled(enabled);
    this.persistPreferences();
    this.render();
  }

  private cycleThinkingMode() {
    const next = cycleThinkingMode(this.state.thinkingMode, this.state.currentModel);
    this.store.setThinkingMode(next);
    this.persistPreferences();
    this.render();
    return next;
  }

  private openCommandArgumentPicker(commandName: string) {
    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.replaceInput(`/${commandName}`);
    this.store.resetSelectedSuggestion();
    this.render();
  }

  private shouldAutoCompact() {
    return this.state.autoCompactEnabled && this.state.lastPromptTokens >= getCompactionTriggerTokens(this.state.currentModel);
  }

  private hasSessionApproval(scope: ApprovalScope) {
    return scope === 'command' ? this.state.commandApprovalSessionAllowed : this.state.editApprovalSessionAllowed;
  }

  private getToolEntry(toolCallId: string) {
    const entry = this.state.historyEntries.find(candidate => candidate.type === 'tool' && candidate.toolCallId === toolCallId);
    return entry?.type === 'tool' ? entry : null;
  }

  private requestApproval = async (request: ApprovalRequest) => {
    if (this.state.autoRunEnabled || this.hasSessionApproval(request.scope)) return true;
    if (this.pendingApprovalResolver) throw new Error('another approval is already pending');

    const decision = await new Promise<ApprovalDecision>(resolve => {
      this.pendingApprovalResolver = resolve;
      this.store.setPendingApproval(request);
      this.render();
    });

    if (decision === 'allow-session') {
      this.store.setApprovalSessionAllowed(request.scope, true);
      this.render();
    }

    return decision !== 'deny';
  };

  private resolvePendingApproval(decision: ApprovalDecision) {
    const resolve = this.pendingApprovalResolver;
    if (!resolve || !this.state.pendingApproval) return false;

    this.pendingApprovalResolver = null;
    this.store.setPendingApproval(null);
    this.render();
    resolve(decision);
    return true;
  }

  private persistCompactionNotice(text: string) {
    const lastEntry = this.state.historyEntries[this.state.historyEntries.length - 1];
    if (lastEntry?.type === 'entry' && lastEntry.kind === EntryKind.Meta && lastEntry.text === text) {
      this.render();
      return;
    }

    this.persistEntry(EntryKind.Meta, text);
  }

  private async compactConversation(options: { manual?: boolean; force?: boolean } = {}) {
    const { manual = false, force = false } = options;

    if (this.state.compacting) return false;
    if (!manual && !this.shouldAutoCompact()) return false;

    if (!canCompactMessages(this.state.messages, undefined, force)) {
      if (manual) this.persistCompactionNotice('(not enough conversation history to compact)');
      return false;
    }

    this.store.setCompacting(true);
    this.render();

    try {
      const result = await compactMessages(this.state.messages, {
        force,
        model: this.state.currentModel,
        thinkingMode: this.state.thinkingMode
      });
      this.store.replaceMessages(result.messages);
      this.store.resetLastUsage();

      const price = calcPrice(pricingUsageFromLanguageModelUsage(result.usage), this.state.currentModel, {
        providerId: 'openai'
      });

      if (price) this.store.addTotalCost(price.total_price);
      this.store.pushHistoryEntry({
        type: 'compacted',
        summary: result.summary,
        previousMessageCount: result.previousMessageCount,
        nextMessageCount: result.nextMessageCount,
        automatic: !manual
      });
      this.render();
      return true;
    } catch (error: unknown) {
      this.persistEntry(
        EntryKind.Error,
        `${manual ? 'compaction' : 'automatic compaction'} failed: ${plain(error instanceof Error ? error.message : String(error))}`
      );
      return false;
    } finally {
      this.store.setCompacting(false);
      this.render();
    }
  }

  private persistHistoryEntries(entries: HistoryEntry[]) {
    for (const entry of entries) this.store.pushHistoryEntry(entry);
    this.render();
  }

  private persistEntry(kind: EntryKind, text: string) {
    if (!text.trim()) return;
    this.persistHistoryEntries([{ type: 'entry', kind, text }]);
  }

  private persistPlain(text: string) {
    if (!text.trim()) return;
    this.persistHistoryEntries([{ type: 'plain', text }]);
  }

  private persistAnsi(text: string) {
    if (!text.trim()) return;
    this.persistHistoryEntries([{ type: 'ansi', text }]);
  }

  private persistLiveOutcome(entries: HistoryEntry[]) {
    this.store.clearLiveAssistantText();
    this.store.clearLiveReasoningText();
    this.store.resetLiveUsage();
    this.persistHistoryEntries(entries);
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
    const trimmedCommand = cmd.trim();
    this.store.setBusyStatusText(trimmedCommand);
    this.store.setBusy(true);
    this.render();

    try {
      const { output, exitCode } = await runUserShell(cmd);
      const trimmed = output.trimEnd();

      this.persistEntry(EntryKind.Shell, `${trimmedCommand} exit ${exitCode}`);
      if (trimmed) this.persistAnsi(trimmed);
      else if (exitCode === 0) this.persistPlain('(no output)');
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

    const slashCommand = this.slashCommands.parse(trimmed);
    if (slashCommand) {
      if (slashCommand.type === 'empty') {
        this.persistEntry(EntryKind.Error, 'missing slash command');
        return;
      }

      if (slashCommand.type === 'unknown') {
        this.persistEntry(EntryKind.Error, `unknown slash command: /${slashCommand.invocation}`);
        return;
      }

      this.store.setBusyStatusText(`/${slashCommand.invocation}`);
      this.store.setBusy(true);
      this.render();

      try {
        await slashCommand.command.execute(
          {
            store: this.store,
            cleanup: code => this.cleanup(code),
            compactConversation: options => this.compactConversation(options),
            setCurrentModel: model => this.setCurrentModel(model),
            setThinkingMode: thinkingMode => this.setThinkingMode(thinkingMode),
            setAutoCompactEnabled: enabled => this.setAutoCompactEnabled(enabled),
            cycleThinkingMode: () => this.cycleThinkingMode(),
            openCommandArgumentPicker: commandName => this.openCommandArgumentPicker(commandName),
            showFooterNotice: (text, durationMs) => this.showFooterNotice(text, durationMs),
            render: this.render,
            persistEntry: (kind, text) => this.persistEntry(kind, text),
            persistPlain: text => this.persistPlain(text),
            persistAnsi: text => this.persistAnsi(text)
          },
          {
            raw: trimmed,
            invocation: slashCommand.invocation,
            argsText: slashCommand.argsText,
            argv: slashCommand.argv
          }
        );
      } catch (error: unknown) {
        this.persistEntry(EntryKind.Error, plain(error instanceof Error ? error.message : String(error)));
      } finally {
        this.store.setBusy(false);
        this.render();
        void this.drainQueuedSubmissions();
      }

      return;
    }

    if (trimmed.startsWith('!')) {
      await this.runShellCommand(trimmed.slice(1));
      return;
    }

    this.persistEntry(EntryKind.User, trimmed);

    const abortController = createAbortController(this.store);

    this.store.setBusy(true);
    this.store.clearLiveAssistantText();
    this.store.clearLiveReasoningText();
    this.store.resetLiveUsage();
    this.render();

    try {
      if (this.shouldAutoCompact()) await this.compactConversation();

      this.store.pushMessage({ role: 'user', content: await this.expand(trimmed) });

      const estimatedPromptTokens = estimateMessageTokens(this.state.messages);
      let completedPromptTokens = 0;
      let completedOutputTokens = 0;
      let completedReasoningTokens = 0;
      let currentStepOutputText = '';
      let currentStepReasoningText = '';

      const syncLiveUsage = () => {
        this.store.setLiveUsage({
          inputTokens: completedPromptTokens > 0 ? completedPromptTokens : estimatedPromptTokens,
          outputTokens: completedOutputTokens + estimateTokenCount(currentStepOutputText),
          reasoningTokens: completedReasoningTokens + estimateTokenCount(currentStepReasoningText)
        });
      };

      syncLiveUsage();
      this.render();

      const result = streamText({
        model: openai(this.state.currentModel),
        messages: this.state.messages,
        tools: this.tools,
        stopWhen: stepCountIs(20),
        abortSignal: abortController.signal,
        providerOptions: createOpenAIProviderOptions(this.state.currentModel, this.state.thinkingMode),
        experimental_context: { subagentDepth: 0 }
      });

      for await (const part of result.fullStream) {
        if (abortController.signal.aborted) break;
        if (this.state.abortRequested && part.type !== 'abort' && part.type !== 'error') continue;

        switch (part.type) {
          case 'abort':
            abortController.signal.throwIfAborted();
            break;
          case 'reasoning-delta':
            currentStepReasoningText += part.text;
            this.store.appendLiveReasoningText(part.text);
            syncLiveUsage();
            this.scheduleRender();
            break;
          case 'text-delta':
            currentStepOutputText += part.text;
            this.store.appendLiveAssistantText(part.text);
            syncLiveUsage();
            this.scheduleRender();
            break;
          case 'finish-step':
            completedPromptTokens += part.usage.inputTokens ?? 0;
            completedOutputTokens += part.usage.outputTokens ?? 0;
            completedReasoningTokens += part.usage.outputTokenDetails.reasoningTokens ?? part.usage.reasoningTokens ?? 0;
            currentStepOutputText = '';
            currentStepReasoningText = '';
            syncLiveUsage();
            this.scheduleRender();
            break;
          case 'tool-call': {
            const fileChanges = await previewFileChangesForToolCall(part.toolName, part.input);
            this.store.upsertToolEntry(createPendingToolEntry({ ...part, fileChanges }));
            this.scheduleRender();
            break;
          }
          case 'tool-result': {
            if (part.preliminary) break;
            const existing = this.getToolEntry(part.toolCallId);
            const completedEntry = createCompletedToolEntry({ ...part, fileChanges: existing?.fileChanges });
            this.store.upsertToolEntry(completedEntry);
            if (completedEntry.fileChanges?.length) this.store.upsertSessionFileChanges(completedEntry.fileChanges);
            this.scheduleRender();
            break;
          }
          case 'tool-error': {
            const existing = this.getToolEntry(part.toolCallId);
            this.store.upsertToolEntry(createFailedToolEntry({ ...part, fileChanges: existing?.fileChanges }));
            this.scheduleRender();
            break;
          }
        }
      }

      abortController.signal.throwIfAborted();

      const [response, usage] = await Promise.all([result.response, result.usage]);
      this.store.pushMessages(response.messages);
      this.store.setLastUsage({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? usage.reasoningTokens
      });

      const price = calcPrice(pricingUsageFromLanguageModelUsage(usage), this.state.currentModel, { providerId: 'openai' });

      if (price) this.store.addTotalCost(price.total_price);
      this.persistLiveOutcome([
        ...(this.state.liveReasoningText.trim()
          ? [{ type: 'entry', kind: EntryKind.Reasoning, text: this.state.liveReasoningText } as const]
          : []),
        ...(this.state.liveAssistantText.trim()
          ? [{ type: 'entry', kind: EntryKind.Assistant, text: this.state.liveAssistantText } as const]
          : [])
      ]);
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        this.persistLiveOutcome([
          ...(this.state.liveReasoningText.trim()
            ? [{ type: 'entry', kind: EntryKind.Reasoning, text: this.state.liveReasoningText } as const]
            : []),
          ...(this.state.liveAssistantText.trim()
            ? [{ type: 'entry', kind: EntryKind.Assistant, text: this.state.liveAssistantText } as const]
            : []),
          { type: 'entry', kind: EntryKind.Meta, text: this.state.steerRequested ? '(steered)' : '(aborted)' }
        ]);
      } else {
        this.persistLiveOutcome([
          ...(this.state.liveReasoningText.trim()
            ? [{ type: 'entry', kind: EntryKind.Reasoning, text: this.state.liveReasoningText } as const]
            : []),
          ...(this.state.liveAssistantText.trim()
            ? [{ type: 'entry', kind: EntryKind.Assistant, text: this.state.liveAssistantText } as const]
            : []),
          { type: 'entry', kind: EntryKind.Error, text: plain(error instanceof Error ? error.message : String(error)) }
        ]);
      }
    } finally {
      this.store.clearLiveAssistantText();
      this.store.clearLiveReasoningText();
      this.store.resetLiveUsage();
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

  private resetPreferredComposerColumn() {
    this.preferredComposerColumn = null;
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

      this.resetPreferredComposerColumn();
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
      this.resetPreferredComposerColumn();
      this.store.replaceInput(draft);
    } else {
      this.historyNavigationIndex = nextIndex;
      this.resetPreferredComposerColumn();
      this.store.replaceInput(history[nextIndex]);
    }

    this.store.resetSelectedSuggestion();
    this.render();
    return true;
  }

  private requestSteer() {
    const controller = this.state.abortController;
    if (!this.state.busy || !controller || this.state.queuedSubmissions.length === 0 || this.state.steerRequested) return false;

    this.store.setSteerRequested(true);
    this.store.setAbortRequested(true);
    controller.abort();
    this.render();
    return true;
  }

  private async submit() {
    const raw = this.state.inputChars.join('');
    const trimmed = raw.trim();

    if (!trimmed) {
      if (this.requestSteer()) return;
      return;
    }

    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.render();

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
    this.resetPreferredComposerColumn();
    this.store.insertText(text);

    if (this.getSuggestions().length === 0) this.store.resetSelectedSuggestion();

    this.render();
  }

  private insertPastedText(text: string) {
    const normalized = normalizePtyOutput(text);
    if (!normalized) return;

    this.historyNavigationIndex = null;
    this.resetPreferredComposerColumn();
    this.store.insertPastedText(normalized);

    if (this.getSuggestions().length === 0) this.store.resetSelectedSuggestion();

    this.render();
  }

  private moveSuggestionSelection(delta: number) {
    const suggestions = this.getSuggestions();
    if (suggestions.length === 0) return false;

    this.resetPreferredComposerColumn();
    this.store.setSelectedSuggestion((this.state.selectedSuggestion + delta + suggestions.length) % suggestions.length);
    this.render();
    return true;
  }

  private moveComposerCursorVertical(delta: number) {
    const next = moveComposerCursorVertical(
      {
        inputChars: this.state.inputChars,
        pasteRanges: this.state.pasteRanges,
        cursor: this.state.cursor,
        slashCommandLength: this.getSlashCommandLength()
      },
      Math.max(1, frameWidth() - 4),
      delta,
      this.preferredComposerColumn ?? undefined
    );

    if (!next || next.cursor === this.state.cursor) return false;

    this.preferredComposerColumn = next.preferredColumn;
    this.store.setCursor(next.cursor);
    this.render();
    return true;
  }

  private tryAcceptSuggestion() {
    const suggestions = this.normalizeSuggestions();
    const accepted = acceptComposerSuggestion(this.store, suggestions);
    if (!accepted) return false;

    this.store.resetSelectedSuggestion();
    this.render();
    return true;
  }

  private async tryAcceptAndSubmitSlashCommandSuggestion() {
    const currentSlashCommand = this.getCurrentSlashCommand();
    if (currentSlashCommand?.type !== 'resolved') return false;

    const suggestions = this.normalizeSuggestions();
    const selectedSuggestion = suggestions[this.state.selectedSuggestion];
    if (selectedSuggestion?.kind !== 'slash-command') return false;
    if (selectedSuggestion.commandName !== currentSlashCommand.command.name) return false;

    if (selectedSuggestion.disabled) {
      this.showFooterNotice(selectedSuggestion.detail || 'Unavailable');
      return true;
    }

    const accepted = acceptComposerSuggestion(this.store, suggestions);
    if (!accepted) return false;

    const raw = this.state.inputChars.join('');
    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.render();

    if (!raw.trim()) return true;

    if (this.state.busy || this.state.queuedSubmissions.length > 0 || this.drainingQueuedSubmissions) {
      this.store.enqueueSubmission(raw);
      this.render();
      void this.drainQueuedSubmissions();
      return true;
    }

    await this.processSubmission(raw);
    return true;
  }

  private handlePendingApprovalBinding(binding: ReturnType<typeof resolveInputBinding>) {
    if (!this.state.pendingApproval || !binding) return false;

    if (binding.type === 'escape') return this.resolvePendingApproval('deny');
    if (binding.type !== 'insertText') return true;

    const key = binding.text.trim().toLowerCase();
    if (key === 'y') return this.resolvePendingApproval('allow-once');
    if (key === 's') return this.resolvePendingApproval('allow-session');
    if (key === 'n') return this.resolvePendingApproval('deny');
    return true;
  }

  private handleEscape() {
    if (this.state.exitConfirmationPending) {
      this.store.setExitConfirmationPending(false);
      this.render();
      return;
    }

    if (handleAbortKeypress(this.store)) {
      this.render();
      return;
    }

    if (this.state.inputChars.length === 0 && this.state.selectedSuggestion === 0) return;
    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.render();
  }

  private handleDelete(backward: boolean) {
    const changed = backward ? this.store.deleteBackward() : this.store.deleteForward();
    if (!changed) return;

    this.historyNavigationIndex = null;
    this.resetPreferredComposerColumn();

    if (this.getSuggestions().length === 0) this.store.resetSelectedSuggestion();
    this.render();
  }

  private handleInputBinding = async (binding: ReturnType<typeof resolveInputBinding>) => {
    if (!binding) return;

    if (binding.type === 'interrupt') {
      if (!this.shouldConfirmExit()) {
        this.cleanup(0);
        return;
      }

      if (!this.state.exitConfirmationPending) {
        this.store.setExitConfirmationPending(true);
        this.render();
        return;
      }

      this.cleanup(0);
      return;
    }

    if (this.handlePendingApprovalBinding(binding)) return;

    if (binding.type === 'escape') {
      this.handleEscape();
      return;
    }

    if (this.state.exitConfirmationPending) this.store.setExitConfirmationPending(false);

    if (this.state.abortConfirmationPending) {
      this.store.setAbortConfirmationPending(false);
      this.render();
    }

    if (binding.type === 'toggleThinkingMode') {
      this.cycleThinkingMode();
      return;
    }

    if (binding.type === 'acceptSuggestion') {
      this.tryAcceptSuggestion();
      return;
    }

    if (binding.type === 'submit') {
      if (await this.tryAcceptAndSubmitSlashCommandSuggestion()) return;
      if (this.getCurrentSlashCommand()?.type !== 'resolved' && this.tryAcceptSuggestion()) return;
      await this.submit();
      return;
    }

    switch (binding.type) {
      case 'moveSuggestion': {
        if (this.moveSuggestionSelection(binding.delta)) return;
        if (this.moveComposerCursorVertical(binding.delta)) return;
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
        this.resetPreferredComposerColumn();
        this.store.setCursor(this.state.cursor + binding.delta);
        this.render();
        return;
      case 'cursorHome':
        this.resetPreferredComposerColumn();
        this.store.setCursor(0);
        this.render();
        return;
      case 'cursorEnd':
        this.resetPreferredComposerColumn();
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

  private onInputBinding = async (chunk: Buffer | string) => {
    await this.handleInputBinding(resolveInputBinding(chunk));
  };

  private processNonPasteInput = async (text: string) => {
    if (!text) return;

    const binding = resolveInputBinding(text);
    if (binding) {
      await this.handleInputBinding(binding);
      return;
    }

    if (!text.includes('\u001b')) this.insertText(text);
  };

  private onStdinData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.stdinBuffer += text;

    void (async () => {
      while (this.stdinBuffer.length > 0) {
        if (this.bracketedPasteActive) {
          const endIndex = this.stdinBuffer.indexOf(BRACKETED_PASTE_END);
          if (endIndex === -1) {
            this.bracketedPasteBuffer += this.stdinBuffer;
            this.stdinBuffer = '';
            return;
          }

          this.bracketedPasteBuffer += this.stdinBuffer.slice(0, endIndex);
          this.stdinBuffer = this.stdinBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
          this.bracketedPasteActive = false;
          this.insertPastedText(this.bracketedPasteBuffer);
          this.bracketedPasteBuffer = '';
          continue;
        }

        const startIndex = this.stdinBuffer.indexOf(BRACKETED_PASTE_START);
        if (startIndex !== -1) {
          const before = this.stdinBuffer.slice(0, startIndex);
          this.stdinBuffer = this.stdinBuffer.slice(startIndex + BRACKETED_PASTE_START.length);
          if (before) await this.processNonPasteInput(before);
          this.bracketedPasteActive = true;
          this.bracketedPasteBuffer = '';
          continue;
        }

        const suffixLength = bracketedPasteSuffixLength(this.stdinBuffer);
        const complete = this.stdinBuffer.slice(0, this.stdinBuffer.length - suffixLength);
        this.stdinBuffer = this.stdinBuffer.slice(this.stdinBuffer.length - suffixLength);

        if (complete) await this.processNonPasteInput(complete);
        return;
      }
    })();
  };
}
