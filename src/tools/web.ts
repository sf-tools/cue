import { openai } from '@ai-sdk/openai';

export function createWebSearchTool() {
  return openai.tools.webSearch({
    externalWebAccess: true,
    searchContextSize: 'medium'
  });
}
