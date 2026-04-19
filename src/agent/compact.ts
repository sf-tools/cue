import { openai } from '@ai-sdk/openai';
import { generateText, type LanguageModelUsage, type ModelMessage } from 'ai';

import { COMPACTION_PROMPT, COMPACTION_RECENT_MESSAGE_COUNT, MODEL } from '@/config';
import { plain } from '@/text';

export type CompactMessagesOptions = {
  recentMessageCount?: number;
  force?: boolean;
};

export type CompactionResult = {
  summary: string;
  messages: ModelMessage[];
  previousMessageCount: number;
  nextMessageCount: number;
  usage: LanguageModelUsage;
};

function extractSummary(text: string) {
  const normalized = plain(text).trim();
  const match = normalized.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  const summary = (match?.[1] ?? normalized).trim();

  if (!summary) throw new Error('empty compaction summary');
  return summary;
}

function getSystemMessages(messages: ModelMessage[]) {
  return messages.filter(message => message.role === 'system');
}

function getConversationMessages(messages: ModelMessage[]) {
  return messages.filter(message => message.role !== 'system');
}

function resolveTailCount(conversationMessages: ModelMessage[], recentMessageCount: number, force: boolean) {
  if (!force) return recentMessageCount;
  return Math.min(recentMessageCount, Math.max(0, conversationMessages.length - 1));
}

export function canCompactMessages(
  messages: ModelMessage[],
  recentMessageCount = COMPACTION_RECENT_MESSAGE_COUNT,
  force = false
) {
  return getConversationMessages(messages).length > resolveTailCount(getConversationMessages(messages), recentMessageCount, force);
}

export async function compactMessages(messages: ModelMessage[], options: CompactMessagesOptions = {}): Promise<CompactionResult> {
  const { recentMessageCount = COMPACTION_RECENT_MESSAGE_COUNT, force = false } = options;
  const systemMessages = getSystemMessages(messages);
  const conversationMessages = getConversationMessages(messages);
  const tailCount = resolveTailCount(conversationMessages, recentMessageCount, force);
  const tail = conversationMessages.slice(-tailCount);
  const messagesToSummarize = conversationMessages.slice(0, Math.max(0, conversationMessages.length - tail.length));

  if (messagesToSummarize.length === 0) throw new Error('not enough conversation history to compact');

  const { text, usage } = await generateText({
    model: openai(MODEL),
    messages: [...systemMessages, ...messagesToSummarize, { role: 'user', content: COMPACTION_PROMPT }]
  });

  const summary = extractSummary(text);
  const compactedMessages: ModelMessage[] = [...systemMessages, { role: 'assistant', content: `<summary>\n${summary}\n</summary>` }, ...tail];

  return {
    summary,
    messages: compactedMessages,
    previousMessageCount: messages.length,
    nextMessageCount: compactedMessages.length,
    usage
  };
}
