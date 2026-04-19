import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { truncate } from './utils';

type WorktreeRecord = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
};

function parseWorktreeList(stdout: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      if (current) {
        records.push(current);
        current = null;
      }
      continue;
    }

    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');

    if (key === 'worktree') {
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
    } else if (current) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') current.detached = true;
      else if (key === 'bare') current.bare = true;
      else if (key === 'locked') current.locked = true;
      else if (key === 'prunable') current.prunable = true;
    }
  }

  if (current) records.push(current);
  return records;
}

function describeRecord(record: WorktreeRecord) {
  const flags: string[] = [];
  if (record.detached) flags.push('detached');
  if (record.bare) flags.push('bare');
  if (record.locked) flags.push('locked');
  if (record.prunable) flags.push('prunable');
  const head = record.head ? record.head.slice(0, 8) : '???????';
  const ref = record.branch ?? '(detached)';
  const flagText = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
  return `${record.path} · ${ref} @ ${head}${flagText}`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createWorktreeTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      "Manage git worktrees: list/add/remove/prune/lock/unlock. Use worktrees for isolated parallel work (subagent exploration, build matrix testing) without touching the user's working tree.",
    inputSchema: z.discriminatedUnion('action', [
      z.object({ action: z.literal('list') }),
      z.object({
        action: z.literal('add'),
        path: z.string().min(1).describe('Path for the new worktree (relative or absolute).'),
        branch: z.string().min(1).optional().describe('Existing branch to check out.'),
        new_branch: z.string().min(1).optional().describe('New branch to create at the worktree.'),
        ref: z
          .string()
          .min(1)
          .optional()
          .describe('Commit/ref to base the new branch on (defaults to HEAD).'),
        force: z.boolean().optional(),
      }),
      z.object({
        action: z.literal('remove'),
        path: z.string().min(1),
        force: z.boolean().optional(),
      }),
      z.object({
        action: z.literal('prune'),
        dry_run: z.boolean().optional(),
      }),
      z.object({
        action: z.literal('lock'),
        path: z.string().min(1),
        reason: z.string().optional(),
      }),
      z.object({
        action: z.literal('unlock'),
        path: z.string().min(1),
      }),
    ]),
    execute: async input => {
      if (input.action === 'list') {
        const result = await runUserShell('git worktree list --porcelain');
        if (result.exitCode !== 0)
          return `error: ${plain(result.output).trim() || `git exited ${result.exitCode}`}`;
        const records = parseWorktreeList(plain(result.output));
        if (records.length === 0) return '(no worktrees)';
        return records.map(describeRecord).join('\n');
      }

      let cmd: string;
      let title: string;

      if (input.action === 'add') {
        const parts = ['git worktree add'];
        if (input.force) parts.push('--force');
        if (input.new_branch) parts.push('-b', shellQuote(input.new_branch));
        parts.push(shellQuote(input.path));
        if (input.branch && !input.new_branch) parts.push(shellQuote(input.branch));
        else if (input.ref) parts.push(shellQuote(input.ref));
        cmd = parts.join(' ');
        title = `Add worktree at ${input.path}`;
      } else if (input.action === 'remove') {
        cmd = `git worktree remove${input.force ? ' --force' : ''} ${shellQuote(input.path)}`;
        title = `Remove worktree at ${input.path}`;
      } else if (input.action === 'prune') {
        cmd = `git worktree prune${input.dry_run ? ' -n' : ''} -v`;
        title = input.dry_run ? 'Preview worktree prune' : 'Prune worktrees';
      } else if (input.action === 'lock') {
        cmd = `git worktree lock${input.reason ? ` --reason ${shellQuote(input.reason)}` : ''} ${shellQuote(input.path)}`;
        title = `Lock worktree at ${input.path}`;
      } else {
        cmd = `git worktree unlock ${shellQuote(input.path)}`;
        title = `Unlock worktree at ${input.path}`;
      }

      if (!(await requestApproval({ scope: 'command', title, detail: cmd }))) {
        throw new Error('command denied by user');
      }

      const result = await runUserShell(cmd);
      const output = plain(result.output).trim();
      if (result.exitCode !== 0)
        return `error (exit ${result.exitCode}):\n${truncate(output) || '(no output)'}`;
      return truncate(output) || `ok (${cmd})`;
    },
  });
}
