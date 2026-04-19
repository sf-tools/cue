import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';

const MAX_OUTPUT_CHARS = 6000;

function truncate(text: string, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… truncated ${text.length - max} chars`;
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function detectInProgress(cwd: string) {
  const gitDir = join(cwd, '.git');
  const inMerge = await exists(join(gitDir, 'MERGE_HEAD'));
  const inRebase = (await exists(join(gitDir, 'rebase-merge'))) || (await exists(join(gitDir, 'rebase-apply')));
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
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      const startLine = i + 1;
      i += 1;
      const ours: string[] = [];
      const base: string[] = [];
      const theirs: string[] = [];
      let hasBase = false;
      while (i < lines.length && !lines[i].startsWith('=======') && !lines[i].startsWith('|||||||')) {
        ours.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].startsWith('|||||||')) {
        hasBase = true;
        i += 1;
        while (i < lines.length && !lines[i].startsWith('=======')) {
          base.push(lines[i]);
          i += 1;
        }
      }
      if (i < lines.length && lines[i].startsWith('=======')) {
        i += 1;
        while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
          theirs.push(lines[i]);
          i += 1;
        }
      }
      const endLine = i + 1;
      i += 1;
      hunks.push({
        startLine,
        endLine,
        ours: ours.join('\n'),
        base: hasBase ? base.join('\n') : null,
        theirs: theirs.join('\n')
      });
    } else {
      i += 1;
    }
  }
  return hunks;
}

export function createGitOpsTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Git operations and conflict resolution. Subactions: status, conflicts.list, conflicts.show, conflicts.resolve, merge, rebase, cherry-pick, abort, continue.',
    inputSchema: z.object({
      action: z.enum([
        'status',
        'conflicts.list',
        'conflicts.show',
        'conflicts.resolve',
        'merge',
        'rebase',
        'cherry-pick',
        'abort',
        'continue'
      ]),
      path: z.string().optional(),
      content: z.string().optional(),
      target: z.string().optional(),
      op: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']).optional(),
      noCommit: z.boolean().optional()
    }),
    execute: async ({ action, path, content, target, op, noCommit }) => {
      const cwd = process.cwd();

      if (action === 'status') {
        const [{ output: branchOut }, { output: statusOut }, { output: aheadBehind }] = await Promise.all([
          runUserShell('git rev-parse --abbrev-ref HEAD'),
          runUserShell('git status --porcelain=v1 -b'),
          runUserShell('git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null || true')
        ]);
        const inProgress = await detectInProgress(cwd);
        const branch = plain(branchOut).trim();
        const status = plain(statusOut).trim();
        const ab = plain(aheadBehind).trim().split(/\s+/);
        const behind = ab[0] ? Number(ab[0]) : null;
        const ahead = ab[1] ? Number(ab[1]) : null;
        const conflicted = status
          .split('\n')
          .filter(line => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line))
          .map(line => line.slice(3));
        return {
          branch,
          ahead,
          behind,
          inProgress,
          conflictedFiles: conflicted,
          status: truncate(status, 2000)
        };
      }

      if (action === 'conflicts.list') {
        const { output } = await runUserShell('git diff --name-only --diff-filter=U');
        const files = plain(output).trim().split('\n').filter(Boolean);
        const summaries = await Promise.all(
          files.map(async file => {
            try {
              const text = await readFile(join(cwd, file), 'utf8');
              const hunks = parseConflictHunks(text);
              return { file, hunks: hunks.length };
            } catch {
              return { file, hunks: 0 };
            }
          })
        );
        return { count: files.length, files: summaries };
      }

      if (action === 'conflicts.show') {
        if (!path) throw new Error('conflicts.show requires `path`');
        const text = await readFile(join(cwd, path), 'utf8');
        const hunks = parseConflictHunks(text);
        return {
          path,
          hunks: hunks.map(h => ({
            startLine: h.startLine,
            endLine: h.endLine,
            ours: truncate(h.ours, 1500),
            base: h.base === null ? null : truncate(h.base, 1500),
            theirs: truncate(h.theirs, 1500)
          }))
        };
      }

      if (action === 'conflicts.resolve') {
        if (!path) throw new Error('conflicts.resolve requires `path`');
        if (typeof content !== 'string') throw new Error('conflicts.resolve requires `content` (full file body after resolution)');
        if (/^(<<<<<<<|=======|>>>>>>>)/m.test(content)) {
          throw new Error('resolution still contains conflict markers');
        }
        const fullPath = join(cwd, path);
        const previous = (await readFile(fullPath, 'utf8').catch(() => '')) || '';
        const before = parseConflictHunks(previous).length;
        if (
          !(await requestApproval({
            scope: 'edit',
            title: 'Resolve git conflict',
            detail: `${path} · ${before} hunk${before === 1 ? '' : 's'} → resolved (${content.length} bytes)`,
            body: content.split('\n').slice(0, 8)
          }))
        ) {
          throw new Error('conflict resolution denied by user');
        }
        await writeFile(fullPath, content);
        const { output, exitCode } = await runUserShell(`git add -- ${JSON.stringify(path)}`);
        if (exitCode !== 0) throw new Error(plain(output).trim() || `git add failed (${exitCode})`);
        return { resolved: path, hunksClosed: before };
      }

      if (action === 'merge' || action === 'rebase' || action === 'cherry-pick') {
        if (!target) throw new Error(`${action} requires \`target\` (branch or commit)`);
        const flag = noCommit && action !== 'rebase' ? ' --no-commit' : '';
        const cmd = `git ${action}${flag} ${JSON.stringify(target)}`;
        if (
          !(await requestApproval({
            scope: 'command',
            title: `Run git ${action}`,
            detail: cmd,
            body: [`target: ${target}`]
          }))
        ) {
          throw new Error(`${action} denied by user`);
        }
        const { output, exitCode } = await runUserShell(cmd);
        const text = truncate(plain(output).trimEnd());
        const inProgress = await detectInProgress(cwd);
        return { exitCode, ok: exitCode === 0, inProgress, output: text || '(no output)' };
      }

      if (action === 'abort' || action === 'continue') {
        const inProgress = (await detectInProgress(cwd)) ?? op;
        if (!inProgress) throw new Error(`no in-progress operation detected; pass \`op\` to ${action} explicitly`);
        const cmd = `git ${inProgress} --${action}`;
        if (
          !(await requestApproval({
            scope: 'command',
            title: `git ${inProgress} --${action}`,
            detail: cmd
          }))
        ) {
          throw new Error(`${action} denied by user`);
        }
        const { output, exitCode } = await runUserShell(cmd);
        return { exitCode, ok: exitCode === 0, output: truncate(plain(output).trimEnd()) || '(no output)' };
      }

      throw new Error(`unknown action: ${String(action)}`);
    }
  });
}
