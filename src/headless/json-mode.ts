import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

import { calcPrice } from '@pydantic/genai-prices';
import { openai } from '@ai-sdk/openai';
import { streamText, stepCountIs, type ModelMessage } from 'ai';

import { runUserShell } from '@/agent/shell';
import {
  createInitialMessages,
  createOpenAIProviderOptions,
  getSupportedThinkingModes,
  loadCuePreferences,
  normalizeOpenAIModelId,
  pricingUsageFromLanguageModelUsage,
  type ThinkingMode
} from '@/config';
import { createTools } from '@/tools';
import type { JsonCliResult } from '@/cli';
import type { ApprovalRequest, ChoiceRequest, ChoiceSelection } from '@/types';
import type { UndoEntry } from '@/undo';

type JsonEvent =
  | {
      type: 'system';
      subtype: 'init';
      session_id: string;
      cwd: string;
      model: string;
      reasoning: ThinkingMode;
      include_thinking: boolean;
      approval_mode: 'allow_all' | 'deny_all';
      prompt_source: 'arg' | 'stdin';
      tools: string[];
    }
  | {
      type: 'system';
      subtype: 'approval';
      session_id: string;
      scope: ApprovalRequest['scope'];
      title: string;
      detail: string;
      decision: 'allow' | 'deny';
    }
  | {
      type: 'system';
      subtype: 'choice';
      session_id: string;
      title: string;
      detail: string;
      recommended_value?: string;
      selected: {
        value: string;
        label: string;
        detail?: string;
        index: number;
      };
    }
  | {
      type: 'assistant';
      subtype: 'reasoning_delta' | 'text_delta';
      session_id: string;
      delta: string;
    }
  | {
      type: 'assistant';
      subtype: 'tool_call';
      session_id: string;
      tool_call_id: string;
      tool_name: string;
      input: unknown;
    }
  | {
      type: 'assistant';
      subtype: 'tool_result';
      session_id: string;
      tool_call_id: string;
      tool_name: string;
      input: unknown;
      output: unknown;
    }
  | {
      type: 'assistant';
      subtype: 'tool_error';
      session_id: string;
      tool_call_id: string;
      tool_name: string;
      input: unknown;
      error: string;
    }
  | {
      type: 'result';
      subtype: 'success';
      session_id: string;
      is_error: false;
      duration_ms: number;
      num_steps: number;
      result: string;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        reasoning_tokens: number;
        total_tokens: number;
      };
      cost_usd?: number;
      permission_denials?: string[];
    }
  | {
      type: 'result';
      subtype: 'error';
      session_id: string;
      is_error: true;
      duration_ms: number;
      num_steps: number;
      error: string;
      permission_denials?: string[];
    };

const PLANNING_MODE_PROMPT = [
  '<session-mode name="planning">',
  '- Planning mode is enabled for this turn.',
  '- Focus on discovery, tradeoffs, and a concrete step-by-step plan.',
  '- Do not make file edits or run mutating commands.',
  '- Use read-only tools only.',
  '- If the plan depends on a meaningful product or architecture choice, use choice_selector before committing to the plan.',
  '- End with a concise recommendation and plan.',
  '</session-mode>'
].join('\n');

function getActiveTools(tools: ReturnType<typeof createTools>, planningMode: boolean) {
  if (!planningMode) return tools;

  const { choice_selector, oracle, planning_mode, read, rg, ripgrep, subagent, web_search } = tools;
  return { read, ripgrep, rg, web_search, oracle, subagent, choice_selector, planning_mode };
}

function getRuntimeMessages(messages: ModelMessage[], planningMode: boolean) {
  if (!planningMode) return messages;

  const [first, ...rest] = messages;
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${PLANNING_MODE_PROMPT}` }, ...rest];
  }

  return [{ role: 'system', content: PLANNING_MODE_PROMPT }, ...messages];
}

function normalizeReasoning(model: string, requestedReasoning: ThinkingMode): ThinkingMode {
  const supported = getSupportedThinkingModes(model);
  return supported.includes(requestedReasoning) ? requestedReasoning : (supported[0] ?? 'auto');
}

function usageToJson(usage: Awaited<ReturnType<Awaited<ReturnType<typeof streamText>>['usage']>>) {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const reasoningTokens = usage.outputTokenDetails.reasoningTokens ?? usage.reasoningTokens ?? 0;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: inputTokens + outputTokens
  };
}

async function emit(event: JsonEvent) {
  const line = `${JSON.stringify(event)}\n`;

  if (!process.stdout.write(line)) {
    await once(process.stdout, 'drain');
  }
}

async function readStdinText() {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function expandPrompt(input: string) {
  let out = input;

  for (const match of input.match(/@[^\s]+/g) || []) {
    try {
      const path = match.slice(1);
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      out += `\n\n<file path="${path}">\n${await file.text()}\n</file>`;
    } catch {}
  }

  return out;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function runJsonHeadlessMode(options: JsonCliResult): Promise<number> {
  const sessionId = randomUUID();
  const startedAt = Date.now();
  const permissionDenials: string[] = [];
  const undoStack: UndoEntry[] = [];
  let planningMode = false;
  let assistantText = '';
  let numSteps = 0;

  try {
    const stdinText = await readStdinText();
    const promptSource = options.prompt !== undefined ? 'arg' : 'stdin';
    const prompt = options.prompt ?? stdinText ?? '';

    if (!prompt.trim()) {
      await emit({
        type: 'result',
        subtype: 'error',
        session_id: sessionId,
        is_error: true,
        duration_ms: Date.now() - startedAt,
        num_steps: 0,
        error: 'Headless JSON mode requires a prompt via --prompt, positional text, or piped stdin.'
      });
      return 1;
    }

    const preferences = await loadCuePreferences();
    const model = normalizeOpenAIModelId(options.model ?? preferences.model);
    const reasoning = normalizeReasoning(model, options.reasoning ?? preferences.reasoning);

    const requestApproval = async (request: ApprovalRequest) => {
      const decision = options.allowAll ? 'allow' : 'deny';
      await emit({
        type: 'system',
        subtype: 'approval',
        session_id: sessionId,
        scope: request.scope,
        title: request.title,
        detail: request.detail,
        decision
      });

      if (decision === 'allow') return true;

      permissionDenials.push(`${request.scope}: ${request.detail}`);
      return false;
    };

    const requestChoice = async (request: ChoiceRequest): Promise<ChoiceSelection> => {
      const index = request.recommendedValue ? request.options.findIndex(option => option.value === request.recommendedValue) : 0;
      const selectedIndex = index >= 0 ? index : 0;
      const selected = request.options[selectedIndex] ?? request.options[0];

      if (!selected) throw new Error('choice_selector requires at least one option');

      const selection: ChoiceSelection = { ...selected, index: selectedIndex };
      await emit({
        type: 'system',
        subtype: 'choice',
        session_id: sessionId,
        title: request.title,
        detail: request.detail,
        recommended_value: request.recommendedValue,
        selected: {
          value: selection.value,
          label: selection.label,
          detail: selection.detail,
          index: selection.index
        }
      });

      return selection;
    };

    const tools = createTools({
      runUserShell,
      requestApproval,
      requestChoice,
      setPlanningMode: enabled => {
        planningMode = enabled;
      },
      getPlanningMode: () => planningMode,
      getCurrentModel: () => model,
      getThinkingMode: () => reasoning,
      pushUndoEntry: entry => {
        if (!entry.files.some(file => file.previousContent !== file.nextContent)) return;
        undoStack.push(entry);
      },
      peekUndoEntry: () => undoStack[undoStack.length - 1] ?? null,
      popUndoEntry: () => undoStack.pop() ?? null
    });

    await emit({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      cwd: process.cwd(),
      model,
      reasoning,
      include_thinking: options.includeThinking,
      approval_mode: options.allowAll ? 'allow_all' : 'deny_all',
      prompt_source: promptSource,
      tools: Object.keys(getActiveTools(tools, planningMode)).sort()
    });

    const controller = new AbortController();
    const handleSignal = () => controller.abort('cancelled');

    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);

    try {
      const messages: ModelMessage[] = [...createInitialMessages(), { role: 'user', content: await expandPrompt(prompt.trim()) }];

      const result = streamText({
        model: openai(model),
        messages: getRuntimeMessages(messages, planningMode),
        tools: getActiveTools(tools, planningMode),
        stopWhen: stepCountIs(20),
        abortSignal: controller.signal,
        providerOptions: createOpenAIProviderOptions(model, reasoning, { includeReasoningSummary: options.includeThinking }),
        experimental_context: { subagentDepth: 0 }
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'abort':
            controller.signal.throwIfAborted();
            break;
          case 'reasoning-delta':
            if (!options.includeThinking || !part.text) break;
            await emit({
              type: 'assistant',
              subtype: 'reasoning_delta',
              session_id: sessionId,
              delta: part.text
            });
            break;
          case 'text-delta':
            if (!part.text) break;
            assistantText += part.text;
            await emit({
              type: 'assistant',
              subtype: 'text_delta',
              session_id: sessionId,
              delta: part.text
            });
            break;
          case 'finish-step':
            numSteps += 1;
            break;
          case 'tool-call':
            await emit({
              type: 'assistant',
              subtype: 'tool_call',
              session_id: sessionId,
              tool_call_id: part.toolCallId,
              tool_name: part.toolName,
              input: part.input
            });
            break;
          case 'tool-result':
            if (part.preliminary) break;
            await emit({
              type: 'assistant',
              subtype: 'tool_result',
              session_id: sessionId,
              tool_call_id: part.toolCallId,
              tool_name: part.toolName,
              input: part.input,
              output: part.output
            });
            break;
          case 'tool-error':
            await emit({
              type: 'assistant',
              subtype: 'tool_error',
              session_id: sessionId,
              tool_call_id: part.toolCallId,
              tool_name: part.toolName,
              input: part.input,
              error: errorMessage(part.error)
            });
            break;
        }
      }

      controller.signal.throwIfAborted();

      const usage = await result.usage;
      const price = calcPrice(pricingUsageFromLanguageModelUsage(usage), model, { providerId: 'openai' });

      await emit({
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        is_error: false,
        duration_ms: Date.now() - startedAt,
        num_steps: numSteps,
        result: assistantText,
        usage: usageToJson(usage),
        cost_usd: price?.total_price,
        permission_denials: permissionDenials.length > 0 ? permissionDenials : undefined
      });

      return 0;
    } finally {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
    }
  } catch (error: unknown) {
    await emit({
      type: 'result',
      subtype: 'error',
      session_id: sessionId,
      is_error: true,
      duration_ms: Date.now() - startedAt,
      num_steps: numSteps,
      error: errorMessage(error),
      permission_denials: permissionDenials.length > 0 ? permissionDenials : undefined
    });

    return 1;
  }
}
