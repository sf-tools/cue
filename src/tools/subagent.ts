import { generateText, stepCountIs, tool, type ModelMessage } from 'ai';
import { z } from 'zod';

import { createOpenAIProviderOptions, SYSTEM_PROMPT } from '@/config';
import { loadCueCloudModel } from '@/cloud/openai';
import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { createReadTool } from './read';
import { createRipgrepTool } from './ripgrep';
import { createWebSearchTool } from './web';

const DEFAULT_MAX_STEPS = 6;
const MAX_MAX_STEPS = 12;
const MAX_CONTEXT_CHARS = 3_000;

const SUBAGENT_MODE = {
  research: 'research',
} as const;

type SubagentMode = keyof typeof SUBAGENT_MODE;

type SubagentContext = {
  subagentDepth?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function contentToText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (
          part &&
          typeof part === 'object' &&
          'type' in part &&
          part.type === 'text' &&
          'text' in part &&
          typeof part.text === 'string'
        ) {
          return part.text;
        }

        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join('\n');
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function latestUserMessage(messages: ModelMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;

    const text = contentToText(message.content).trim();
    if (text) return text;
  }

  return null;
}

function clampMaxSteps(value: number | undefined) {
  if (!value) return DEFAULT_MAX_STEPS;
  return Math.max(1, Math.min(MAX_MAX_STEPS, Math.floor(value)));
}

function truncate(text: string, maxChars = MAX_CONTEXT_CHARS) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… truncated ${text.length - maxChars} chars`;
}

function getSubagentTools(options: ToolFactoryOptions) {
  return {
    read: createReadTool(options),
    ripgrep: createRipgrepTool(options),
    rg: createRipgrepTool(options),
    web_search: createWebSearchTool(),
  };
}

function getSubagentSystemPrompt(mode: SubagentMode) {
  const focus =
    mode === 'research'
      ? [
          'You are a focused research subagent working for a parent coding agent.',
          'Investigate the delegated task and return a concise handoff for the parent agent.',
          'Use tools aggressively for code search and file inspection, but do not edit files.',
          'Keep the delegated task narrow, gather concrete evidence, and cite file paths and symbols when relevant.',
          'Your final answer should be brief and structured with: findings, evidence, and recommended next step.',
        ]
      : ['You are a focused subagent.'];

  return `${SYSTEM_PROMPT}\n\n<subagent mode="${mode}">\n${focus.map(line => `- ${line}`).join('\n')}\n</subagent>`;
}

export function createSubagentTool(options: ToolFactoryOptions) {
  const tools = getSubagentTools(options);

  return tool({
    description:
      'Delegate a focused read-only investigation to a subagent. Best for parallel research, codebase reconnaissance, searching for implementations, or summarizing a subsystem before acting.',
    inputSchema: z.object({
      task: z.string().min(1),
      context: z.string().optional(),
      files: z.array(z.string()).max(20).optional(),
      mode: z.enum(['research']).default('research'),
      maxSteps: z.number().int().positive().max(MAX_MAX_STEPS).optional(),
    }),
    execute: async ({ task, context, files = [], mode = 'research', maxSteps }, execOptions) => {
      const currentContext = (asRecord(execOptions.experimental_context) ?? {}) as SubagentContext;
      const currentDepth =
        typeof currentContext.subagentDepth === 'number' ? currentContext.subagentDepth : 0;

      if (currentDepth >= 1) {
        throw new Error('nested subagents are currently disabled');
      }

      const model = options.getCurrentModel();
      const thinkingMode = options.getThinkingMode();
      const recentUserRequest = latestUserMessage(execOptions.messages);
      const delegatedPrompt = [
        `Delegated task:\n${task.trim()}`,
        context?.trim() ? `Extra context:\n${truncate(context.trim())}` : null,
        files.length > 0
          ? `Files to inspect first:\n${files.map(file => `- ${file}`).join('\n')}`
          : null,
        recentUserRequest ? `Latest user request:\n${truncate(recentUserRequest)}` : null,
        'Return a concise handoff to the parent agent. Prefer concrete evidence over speculation.',
      ]
        .filter(Boolean)
        .join('\n\n');

      try {
        const result = await generateText({
          model: await loadCueCloudModel(model),
          system: getSubagentSystemPrompt(mode),
          prompt: delegatedPrompt,
          tools,
          stopWhen: stepCountIs(clampMaxSteps(maxSteps)),
          providerOptions: createOpenAIProviderOptions(model, thinkingMode),
          experimental_context: { subagentDepth: currentDepth + 1 },
        });

        return {
          mode,
          model,
          summary: result.text.trim() || 'Subagent completed without a final written summary.',
          steps: result.steps.length,
          toolCalls: result.steps.flatMap(step => step.toolCalls.map(call => call.toolName)),
          files,
        };
      } catch (error: unknown) {
        throw new Error(plain(error instanceof Error ? error.message : String(error)));
      }
    },
  });
}
