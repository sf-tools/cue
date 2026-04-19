import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { truncate } from './utils';

const DEFAULT_LOG_LIMIT = 20;
const HARD_LOG_LIMIT = 200;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pathArg(paths: string[] | undefined) {
  if (!paths || paths.length === 0) return '';
  return ` -- ${paths.map(shellQuote).join(' ')}`;
}

function runOutput(prefix: string, exitCode: number, output: string, max = 12000) {
  const cleaned = plain(output).trim();
  if (exitCode !== 0) return `${prefix} failed (exit ${exitCode}):\n${truncate(cleaned, max) || '(no output)'}`;
  return cleaned ? truncate(cleaned, max) : '(no output)';
}

export function createGitHistoryTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Inspect local git history: log (with patches), show a commit, blame a file. All read-only — no approval required.',
    inputSchema: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('log'),
        limit: z.number().int().positive().max(HARD_LOG_LIMIT).optional(),
        ref: z.string().optional().describe('Branch/ref/range, e.g. `main`, `HEAD~10..HEAD`, `feature..main`.'),
        path: z.array(z.string()).optional().describe('Restrict to specific file(s).'),
        author: z.string().optional(),
        grep: z.string().optional().describe('Filter commit messages by regex.'),
        patch: z.boolean().optional().describe('Include unified diff per commit (off by default).'),
        stat: z.boolean().optional().describe('Include diffstat per commit.')
      }),
      z.object({
        action: z.literal('show'),
        ref: z.string().min(1).describe('Commit SHA, tag, or branch name.'),
        path: z.array(z.string()).optional().describe('Restrict diff to specific file(s).'),
        stat_only: z.boolean().optional()
      }),
      z.object({
        action: z.literal('blame'),
        path: z.string().min(1),
        line_start: z.number().int().positive().optional(),
        line_end: z.number().int().positive().optional(),
        ref: z.string().optional().describe('Blame as of this ref (defaults to HEAD).')
      })
    ]),
    execute: async input => {
      if (input.action === 'log') {
        const limit = input.limit ?? DEFAULT_LOG_LIMIT;
        const parts = ['git log', `-n ${limit}`, '--no-color'];
        if (input.patch) parts.push('-p');
        if (input.stat) parts.push('--stat');
        if (input.author) parts.push(`--author=${shellQuote(input.author)}`);
        if (input.grep) parts.push(`--grep=${shellQuote(input.grep)}`);
        if (!input.patch && !input.stat) parts.push('--pretty=format:%h %cs %an: %s');
        if (input.ref) parts.push(shellQuote(input.ref));
        const cmd = `${parts.join(' ')}${pathArg(input.path)}`;
        const { exitCode, output } = await runUserShell(cmd);
        return runOutput('git log', exitCode, output);
      }

      if (input.action === 'show') {
        const parts = ['git show', '--no-color'];
        if (input.stat_only) parts.push('--stat');
        parts.push(shellQuote(input.ref));
        const cmd = `${parts.join(' ')}${pathArg(input.path)}`;
        const { exitCode, output } = await runUserShell(cmd);
        return runOutput('git show', exitCode, output);
      }

      const parts = ['git blame', '--no-color', '-w'];
      if (input.line_start) {
        const end = input.line_end ?? input.line_start;
        parts.push(`-L ${input.line_start},${end}`);
      }
      if (input.ref) parts.push(shellQuote(input.ref));
      parts.push('--', shellQuote(input.path));
      const { exitCode, output } = await runUserShell(parts.join(' '));
      return runOutput('git blame', exitCode, output);
    }
  });
}

export function createGitStashTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Manage the local git stash: list, show, push (save), pop, apply, drop. Mutating actions (push/pop/apply/drop) require approval.',
    inputSchema: z.discriminatedUnion('action', [
      z.object({ action: z.literal('list') }),
      z.object({
        action: z.literal('show'),
        ref: z.string().optional().describe('Stash ref like `stash@{0}` (defaults to latest).'),
        patch: z.boolean().optional()
      }),
      z.object({
        action: z.literal('push'),
        message: z.string().optional(),
        include_untracked: z.boolean().optional(),
        keep_index: z.boolean().optional(),
        path: z.array(z.string()).optional().describe('Stash only these paths.')
      }),
      z.object({
        action: z.literal('pop'),
        ref: z.string().optional().describe('Stash ref to pop (defaults to latest).')
      }),
      z.object({
        action: z.literal('apply'),
        ref: z.string().optional()
      }),
      z.object({
        action: z.literal('drop'),
        ref: z.string().optional()
      })
    ]),
    execute: async input => {
      if (input.action === 'list') {
        const { exitCode, output } = await runUserShell('git stash list --no-color');
        const cleaned = plain(output).trim();
        if (exitCode !== 0) return `git stash list failed (exit ${exitCode}):\n${cleaned || '(no output)'}`;
        return cleaned || '(no stashes)';
      }

      if (input.action === 'show') {
        const parts = ['git stash show', '--no-color'];
        if (input.patch) parts.push('-p');
        if (input.ref) parts.push(shellQuote(input.ref));
        const { exitCode, output } = await runUserShell(parts.join(' '));
        return runOutput('git stash show', exitCode, output);
      }

      let cmd: string;
      let title: string;

      if (input.action === 'push') {
        const parts = ['git stash push'];
        if (input.include_untracked) parts.push('-u');
        if (input.keep_index) parts.push('--keep-index');
        if (input.message) parts.push('-m', shellQuote(input.message));
        cmd = `${parts.join(' ')}${pathArg(input.path)}`;
        title = 'Stash local changes';
      } else if (input.action === 'pop') {
        cmd = `git stash pop${input.ref ? ` ${shellQuote(input.ref)}` : ''}`;
        title = `Pop stash${input.ref ? ` ${input.ref}` : ''}`;
      } else if (input.action === 'apply') {
        cmd = `git stash apply${input.ref ? ` ${shellQuote(input.ref)}` : ''}`;
        title = `Apply stash${input.ref ? ` ${input.ref}` : ''}`;
      } else {
        cmd = `git stash drop${input.ref ? ` ${shellQuote(input.ref)}` : ''}`;
        title = `Drop stash${input.ref ? ` ${input.ref}` : ''}`;
      }

      if (!(await requestApproval({ scope: 'command', title, detail: cmd }))) {
        throw new Error('command denied by user');
      }

      const { exitCode, output } = await runUserShell(cmd);
      return runOutput(cmd, exitCode, output);
    }
  });
}
