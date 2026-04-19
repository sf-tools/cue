import { xml } from '@/xml';
import type { ModelMessage } from 'ai';

export const SYSTEM_PROMPT = xml({
  role: 'cue',
  identity: {
    name: 'Cue',
    maker: 'San Francisco Tooling Company',
    persona: 'terse coding agent'
  },
  context: {
    workspace: process.cwd(),
    capabilities: ['read files', 'write files', 'search workspace with ripgrep', 'run shell commands', 'search the web'],
    responseStyle: 'brief'
  },
  task: 'Help the user build and refine this project using the available tools.',
  guardrails: [
    'Use tools to inspect the workspace before making repository-specific claims.',
    'Keep explanations short and describe what you changed.',
    'Prefer safe, minimal edits that directly address the request.'
  ]
});

export const COMPACTION_PROMPT = xml({
  compaction: {
    goal: 'Write a continuation summary so a future instance can resume the task after older conversation history is replaced with this summary.',
    guidance: [
      'Assume the task is not yet complete.',
      'Be structured, concise, and actionable.',
      'A small recent tail of messages may be preserved separately, so focus on older context that must survive compaction.',
      'Err on the side of preserving details that prevent duplicate work or repeated mistakes.'
    ],
    sections: [
      {
        name: 'Task Overview',
        include: ['the user\'s core request and success criteria', 'clarifications or constraints the user specified']
      },
      {
        name: 'Current State',
        include: ['what has been completed so far', 'files created, modified, or analyzed with paths when relevant', 'key outputs or artifacts produced']
      },
      {
        name: 'Important Discoveries',
        include: [
          'technical constraints or requirements uncovered',
          'decisions made and their rationale',
          'errors encountered and how they were resolved',
          'approaches that did not work and why'
        ]
      },
      {
        name: 'Next Steps',
        include: ['specific remaining actions', 'blockers or open questions', 'priority order when there are multiple next steps']
      },
      {
        name: 'Context to Preserve',
        include: ['user preferences or style requirements', 'domain-specific details that are easy to lose', 'any promises made to the user']
      }
    ],
    output: {
      format: 'Wrap the final continuation summary in <summary></summary> tags.',
      requirement: 'Return only the summary.'
    }
  }
});

export const createInitialMessages = (): ModelMessage[] => [{ role: 'system', content: SYSTEM_PROMPT }];
