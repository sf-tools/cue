import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';
import { truncate } from './utils';

async function ghAvailable(runUserShell: ToolFactoryOptions['runUserShell']) {
  const { exitCode } = await runUserShell('command -v gh >/dev/null 2>&1');
  return exitCode === 0;
}

async function listWorkflowFiles(cwd: string) {
  const dir = join(cwd, '.github', 'workflows');
  try {
    const entries = await readdir(dir);
    return entries
      .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map(name => join('.github/workflows', name));
  } catch {
    return [];
  }
}

function parseWorkflowMeta(text: string) {
  const nameMatch = text.match(/^name:\s*(.+)$/m);
  const triggers: string[] = [];

  const inlineArray = text.match(/^on:\s*\[([^\]]+)\]/m);
  if (inlineArray) {
    triggers.push(...inlineArray[1].split(',').map(value => value.trim()));
  } else {
    const inlineScalar = text.match(/^on:\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*$/m);
    if (inlineScalar) triggers.push(inlineScalar[1]);

    const onMatch = text.match(/^on:\s*([\s\S]*?)(?=^\S|\Z)/m);
    if (onMatch) {
      const block = onMatch[1];
      if (/^\s*push\b/m.test(block)) triggers.push('push');
      if (/^\s*pull_request\b/m.test(block)) triggers.push('pull_request');
      if (/^\s*workflow_dispatch\b/m.test(block)) triggers.push('workflow_dispatch');
      if (/^\s*schedule\b/m.test(block)) triggers.push('schedule');
      if (/^\s*release\b/m.test(block)) triggers.push('release');
    }
  }

  const jobs: string[] = [];
  const jobRe = /^\s{2}([a-zA-Z0-9_-]+):\s*$/gm;
  const jobsHeader = text.match(/^jobs:\s*$([\s\S]*)/m);
  if (jobsHeader) {
    let match: RegExpExecArray | null;
    while ((match = jobRe.exec(jobsHeader[1])) !== null) jobs.push(match[1]);
  }

  return { name: nameMatch?.[1].trim() ?? null, triggers, jobs };
}

async function lintWorkflowFiles(cwd: string, runUserShell: ToolFactoryOptions['runUserShell']) {
  const files = await listWorkflowFiles(cwd);
  if (files.length === 0)
    return {
      ok: true,
      message: 'no workflow files found',
      issues: [] as { file: string; problem: string }[],
    };

  const hasActionlint =
    (await runUserShell('command -v actionlint >/dev/null 2>&1')).exitCode === 0;
  if (hasActionlint) {
    const { output, exitCode } = await runUserShell(
      `actionlint -color=never ${files.map(file => JSON.stringify(file)).join(' ')}`,
    );
    return { ok: exitCode === 0, tool: 'actionlint', output: truncate(plain(output).trimEnd()) };
  }

  const issues: { file: string; problem: string }[] = [];
  for (const file of files) {
    const text = await readFile(join(cwd, file), 'utf8');
    const meta = parseWorkflowMeta(text);
    if (!meta.name) issues.push({ file, problem: 'missing top-level name' });
    if (meta.triggers.length === 0)
      issues.push({ file, problem: 'no triggers detected under `on:`' });
    if (meta.jobs.length === 0) issues.push({ file, problem: 'no jobs detected under `jobs:`' });
    if (/uses:\s*actions\/checkout@(v?[12])\b/.test(text)) {
      issues.push({ file, problem: 'using outdated actions/checkout (<v3); update to @v4' });
    }
    if (/\$\{\{\s*github\.event\.pull_request\.title/.test(text)) {
      issues.push({
        file,
        problem: 'PR title interpolated into shell — script-injection risk; pass via env',
      });
    }
  }

  return { ok: issues.length === 0, tool: 'structural', issues };
}

async function ensureGhAvailable(runUserShell: ToolFactoryOptions['runUserShell']) {
  if (!(await ghAvailable(runUserShell))) {
    throw new Error(
      'gh CLI not found on PATH; install GitHub CLI to inspect or manage workflow runs',
    );
  }
}

export function createCiWorkflowsTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Inspect GitHub Actions workflow files in .github/workflows. Use for listing workflows or linting workflow YAML.',
    inputSchema: z.object({
      action: z.enum(['list', 'lint']),
    }),
    execute: async ({ action }) => {
      const cwd = process.cwd();

      if (action === 'list') {
        const files = await listWorkflowFiles(cwd);
        const workflows = await Promise.all(
          files.map(async file => {
            const text = await readFile(join(cwd, file), 'utf8');
            return { file, ...parseWorkflowMeta(text) };
          }),
        );
        return { count: workflows.length, workflows };
      }

      return await lintWorkflowFiles(cwd, runUserShell);
    },
  });
}

export function createCiRunsTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Inspect or manage GitHub Actions runs through gh CLI. Use for listing runs, viewing one run, re-running a failed run, or canceling a run.',
    inputSchema: z.object({
      action: z.enum(['list', 'view', 'rerun', 'cancel']),
      runId: z.string().optional(),
      workflow: z.string().optional(),
      branch: z.string().optional(),
      limit: z.number().int().positive().max(50).optional(),
      failedOnly: z.boolean().optional(),
      logFailed: z.boolean().optional(),
    }),
    execute: async ({ action, runId, workflow, branch, limit, failedOnly, logFailed }) => {
      await ensureGhAvailable(runUserShell);

      if (action === 'list') {
        const args = ['gh run list', `--limit ${limit ?? 10}`];
        if (workflow) args.push(`--workflow ${JSON.stringify(workflow)}`);
        if (branch) args.push(`--branch ${JSON.stringify(branch)}`);
        args.push(
          '--json databaseId,name,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url',
        );

        const { output, exitCode } = await runUserShell(args.join(' '));
        if (exitCode !== 0) throw new Error(plain(output).trim() || `gh exited ${exitCode}`);

        try {
          return { runs: JSON.parse(plain(output).trim()) };
        } catch {
          return { raw: truncate(plain(output).trimEnd()) };
        }
      }

      if (!runId) throw new Error(`${action} requires \`runId\``);

      if (action === 'view') {
        const cmd = `gh run view ${JSON.stringify(runId)} --json databaseId,name,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,updatedAt,jobs,url`;
        const { output, exitCode } = await runUserShell(cmd);
        if (exitCode !== 0) throw new Error(plain(output).trim() || `gh exited ${exitCode}`);

        let summary: unknown;
        try {
          summary = JSON.parse(plain(output).trim());
        } catch {
          summary = { raw: truncate(plain(output).trimEnd()) };
        }

        let failedLog: string | undefined;
        if (logFailed) {
          const { output: log } = await runUserShell(
            `gh run view ${JSON.stringify(runId)} --log-failed 2>/dev/null | tail -n 200`,
          );
          failedLog = truncate(plain(log).trimEnd(), 4000);
        }

        return { summary, failedLog };
      }

      const cmd =
        action === 'rerun'
          ? failedOnly
            ? `gh run rerun ${JSON.stringify(runId)} --failed`
            : `gh run rerun ${JSON.stringify(runId)}`
          : `gh run cancel ${JSON.stringify(runId)}`;

      const title =
        action === 'rerun'
          ? failedOnly
            ? 'Re-run failed jobs'
            : 'Re-run workflow'
          : 'Cancel workflow run';
      if (
        !(await requestApproval({
          scope: 'command',
          title,
          detail: cmd,
          body: [`run id: ${runId}`],
        }))
      ) {
        throw new Error(`${action} denied by user`);
      }

      const { output, exitCode } = await runUserShell(cmd);
      return { exitCode, ok: exitCode === 0, output: truncate(plain(output).trimEnd()) };
    },
  });
}
