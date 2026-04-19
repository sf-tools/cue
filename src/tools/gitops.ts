import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { exists, truncate } from './utils';

async function detectInProgress(cwd: string) {
  const gitDir = join(cwd, '.git');
  const inMerge = await exists(join(gitDir, 'MERGE_HEAD'));
  const inRebase =
    (await exists(join(gitDir, 'rebase-merge'))) || (await exists(join(gitDir, 'rebase-apply')));
  const inCherryPick = await exists(join(gitDir, 'CHERRY_PICK_HEAD'));
  const inRevert = await exists(join(gitDir, 'REVERT_HEAD'));
  if (inMerge) return 'merge';
  if (inRebase) return 'rebase';
  if (inCherryPick) return 'cherry-pick';
  if (inRevert) return 'revert';
  return null;
}

type ConflictHunk = {
  startLine: number;
  endLine: number;
  ours: string;
  base: string | null;
  theirs: string;
};

function parseConflictHunks(source: string): ConflictHunk[] {
  const lines = source.split('\n');
  const hunks: ConflictHunk[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith('<<<<<<<')) {
      index += 1;
      continue;
    }

    const startLine = index + 1;
    index += 1;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let hasBase = false;

    while (
      index < lines.length &&
      !lines[index].startsWith('=======') &&
      !lines[index].startsWith('|||||||')
    ) {
      ours.push(lines[index]);
      index += 1;
    }

    if (index < lines.length && lines[index].startsWith('|||||||')) {
      hasBase = true;
      index += 1;
      while (index < lines.length && !lines[index].startsWith('=======')) {
        base.push(lines[index]);
        index += 1;
      }
    }

    if (index < lines.length && lines[index].startsWith('=======')) {
      index += 1;
      while (index < lines.length && !lines[index].startsWith('>>>>>>>')) {
        theirs.push(lines[index]);
        index += 1;
      }
    }

    const endLine = index + 1;
    index += 1;
    hunks.push({
      startLine,
      endLine,
      ours: ours.join('\n'),
      base: hasBase ? base.join('\n') : null,
      theirs: theirs.join('\n'),
    });
  }

  return hunks;
}

export function createGitStatusTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Inspect git branch state, worktree status, ahead/behind counts, and whether a merge, rebase, cherry-pick, or revert is in progress.',
    inputSchema: z.object({}),
    execute: async () => {
      const cwd = process.cwd();
      const [{ output: branchOut }, { output: statusOut }, { output: aheadBehind }] =
        await Promise.all([
          runUserShell('git rev-parse --abbrev-ref HEAD'),
          runUserShell('git status --porcelain=v1 -b'),
          runUserShell('git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null || true'),
        ]);

      const inProgress = await detectInProgress(cwd);
      const branch = plain(branchOut).trim();
      const status = plain(statusOut).trim();
      const [behindRaw, aheadRaw] = plain(aheadBehind).trim().split(/\s+/);
      const conflictedFiles = status
        .split('\n')
        .filter(line => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line))
        .map(line => line.slice(3));

      return {
        branch,
        ahead: aheadRaw ? Number(aheadRaw) : null,
        behind: behindRaw ? Number(behindRaw) : null,
        inProgress,
        conflictedFiles,
        status: truncate(status, 2000),
      };
    },
  });
}

export function createGitConflictsTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Inspect or resolve merge conflicts. Use for listing conflicted files, showing conflict hunks in one file, or writing a resolved file and staging it.',
    inputSchema: z.object({
      action: z.enum(['list', 'show', 'resolve']),
      path: z.string().optional(),
      content: z.string().optional(),
    }),
    execute: async ({ action, path, content }) => {
      const cwd = process.cwd();

      if (action === 'list') {
        const { output } = await runUserShell('git diff --name-only --diff-filter=U');
        const files = plain(output).trim().split('\n').filter(Boolean);
        const summaries = await Promise.all(
          files.map(async file => {
            try {
              const text = await readFile(join(cwd, file), 'utf8');
              return { file, hunks: parseConflictHunks(text).length };
            } catch {
              return { file, hunks: 0 };
            }
          }),
        );
        return { count: files.length, files: summaries };
      }

      if (!path) throw new Error(`${action} requires \`path\``);
      const fullPath = join(cwd, path);

      if (action === 'show') {
        const text = await readFile(fullPath, 'utf8');
        const hunks = parseConflictHunks(text);
        return {
          path,
          hunks: hunks.map(hunk => ({
            startLine: hunk.startLine,
            endLine: hunk.endLine,
            ours: truncate(hunk.ours, 1500),
            base: hunk.base === null ? null : truncate(hunk.base, 1500),
            theirs: truncate(hunk.theirs, 1500),
          })),
        };
      }

      if (typeof content !== 'string')
        throw new Error('resolve requires `content` (full file body after resolution)');
      if (/^(<<<<<<<|=======|>>>>>>>)/m.test(content)) {
        throw new Error('resolution still contains conflict markers');
      }

      const previous = (await readFile(fullPath, 'utf8').catch(() => '')) || '';
      const before = parseConflictHunks(previous).length;
      if (
        !(await requestApproval({
          scope: 'edit',
          title: 'Resolve git conflict',
          detail: `${path} · ${before} hunk${before === 1 ? '' : 's'} → resolved (${content.length} bytes)`,
          body: content.split('\n').slice(0, 8),
        }))
      ) {
        throw new Error('conflict resolution denied by user');
      }

      await writeFile(fullPath, content);
      const { output, exitCode } = await runUserShell(`git add -- ${JSON.stringify(path)}`);
      if (exitCode !== 0) throw new Error(plain(output).trim() || `git add failed (${exitCode})`);
      return { resolved: path, hunksClosed: before };
    },
  });
}

export function createGitIntegrateTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Run git merge, rebase, or cherry-pick into the current worktree. Use this for starting an integration operation, not for continue or abort.',
    inputSchema: z.object({
      operation: z.enum(['merge', 'rebase', 'cherry-pick']),
      target: z.string(),
      noCommit: z.boolean().optional(),
    }),
    execute: async ({ operation, target, noCommit }) => {
      const cwd = process.cwd();
      const flag = noCommit && operation !== 'rebase' ? ' --no-commit' : '';
      const cmd = `git ${operation}${flag} ${JSON.stringify(target)}`;

      if (
        !(await requestApproval({
          scope: 'command',
          title: `Run git ${operation}`,
          detail: cmd,
          body: [`target: ${target}`],
        }))
      ) {
        throw new Error(`${operation} denied by user`);
      }

      const { output, exitCode } = await runUserShell(cmd);
      return {
        exitCode,
        ok: exitCode === 0,
        inProgress: await detectInProgress(cwd),
        output: truncate(plain(output).trimEnd()) || '(no output)',
      };
    },
  });
}

export function createGitProgressTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description: 'Continue or abort an in-progress merge, rebase, cherry-pick, or revert.',
    inputSchema: z.object({
      action: z.enum(['continue', 'abort']),
      operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']).optional(),
    }),
    execute: async ({ action, operation }) => {
      const inProgress = operation ?? (await detectInProgress(process.cwd()));
      if (!inProgress)
        throw new Error(
          `no in-progress operation detected; pass \`operation\` explicitly to ${action}`,
        );

      const cmd = `git ${inProgress} --${action}`;
      if (
        !(await requestApproval({
          scope: 'command',
          title: `git ${inProgress} --${action}`,
          detail: cmd,
        }))
      ) {
        throw new Error(`${action} denied by user`);
      }

      const { output, exitCode } = await runUserShell(cmd);
      return {
        exitCode,
        ok: exitCode === 0,
        output: truncate(plain(output).trimEnd()) || '(no output)',
      };
    },
  });
}
