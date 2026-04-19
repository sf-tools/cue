import dedent from 'dedent';

import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs, tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { createOpenAIProviderOptions, type ThinkingMode } from '@/config';
import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';

const DEFAULT_ORACLE_MODEL = 'gpt-5.4-mini';
const DEFAULT_ORACLE_THINKING_MODE: Exclude<ThinkingMode, 'auto'> = 'high';
const MAX_OUTPUT_CHARS = 8_000;

function truncate(text: string, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… truncated ${text.length - max} chars`;
}

function normalizeFiles(files: string[] | undefined) {
  return [...new Set((files ?? []).map(file => file.trim()).filter(Boolean))].slice(0, 24);
}

function resolveOracleModel(options: ToolFactoryOptions) {
  return options.getCurrentModel?.().trim() || DEFAULT_ORACLE_MODEL;
}

function resolveOracleThinkingMode(options: ToolFactoryOptions) {
  return options.getThinkingMode?.() ?? DEFAULT_ORACLE_THINKING_MODE;
}

export function createOracleTool(options: ToolFactoryOptions, inspectionTools: ToolSet) {
  return tool({
    description:
      'Consult the oracle for a skeptical second opinion. Best for reviewing a patch, plan, bug hypothesis, architecture choice, or test strategy. Provide a self-contained task and optional relevant file paths. The oracle can inspect the workspace but cannot modify it.',
    inputSchema: z.object({
      task: z.string().min(1),
      files: z.array(z.string().min(1)).max(24).optional()
    }),
    execute: async ({ task, files }) => {
      const hintedFiles = normalizeFiles(files);
      const model = resolveOracleModel(options);
      const thinkingMode = resolveOracleThinkingMode(options);
      const prompt = [
        `Task:\n${task.trim()}`,
        hintedFiles.length > 0 ? `Relevant file paths:\n- ${hintedFiles.join('\n- ')}` : null,
        `Workspace:\n${process.cwd()}`
      ]
        .filter(Boolean)
        .join('\n\n');

      try {
        const { text } = await generateText({
          model: openai(model),
          tools: inspectionTools,
          stopWhen: stepCountIs(8),
          system: dedent`
            You are Oracle, an internal code-review and debugging subagent used by Cue.

            Your job is to give a sharp second opinion on the caller's task.
            You may inspect the repository with tools, but you cannot edit files or run shell commands.

            Prioritize:
            1. correctness bugs and logic holes
            2. risky assumptions and edge cases
            3. missing tests or verification
            4. simpler, safer alternatives

            Working style:
            - Inspect the repo when the task depends on repository facts.
            - Prefer ripgrep before reading many files.
            - Use web search only for external APIs, libraries, or current information.
            - Be concise, specific, and actionable.
            - If the work looks good, say so clearly and note any residual risks.

            Output format unless the task requests another format:
            - Verdict: one sentence.
            - Findings: bullet list ordered by severity.
            - Recommended next steps: bullet list.
          `,
          prompt,
          providerOptions: createOpenAIProviderOptions(model, thinkingMode, { includeReasoningSummary: false })
        });

        const answer = plain(text).trim();
        if (!answer) throw new Error('oracle returned no analysis');

        return truncate(answer);
      } catch (error: unknown) {
        throw new Error(`oracle failed: ${plain(error instanceof Error ? error.message : String(error))}`);
      }
    }
  });
}
