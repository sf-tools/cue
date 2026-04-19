import { join } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import { objectInputSchema } from './input-schema';
import type { ToolFactoryOptions } from './types';
import { exists, truncate } from './utils';

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function isBisectInProgress(cwd: string) {
  return (await exists(join(cwd, '.git', 'BISECT_LOG'))) || (await exists(join(cwd, '.git', 'BISECT_START')));
}

function parseBisectResult(output: string) {
  const cleaned = plain(output);
  const verdict = cleaned.match(/^([0-9a-f]{7,40}) is the first bad commit/m);
  const giveUp = /No (?:testable|merge bases) found|There are only|cannot reach/.test(cleaned);
  return { firstBad: verdict?.[1] ?? null, giveUp, raw: cleaned };
}

const gitBisectActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    good: z.string().min(1).describe('Commit/ref/tag known to be good (regression not present).'),
    bad: z.string().min(1).describe('Commit/ref/tag known to be bad (regression present, defaults to HEAD).'),
    cmd: z.string().min(1).describe('Test command. Exit 0 = good, 1-127 (except 125) = bad, 125 = skip.'),
    timeout_seconds: z.number().int().positive().max(7200).optional().describe('Wall-clock timeout for the entire bisect (default 1800s).')
  }),
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('reset') }),
  z.object({
    action: z.literal('mark'),
    verdict: z.enum(['good', 'bad', 'skip']),
    ref: z.string().optional().describe('Ref to mark; defaults to current HEAD.')
  })
]);

const gitBisectInputSchema = objectInputSchema(
  gitBisectActionSchema,
  z.object({
    action: z.enum(['start', 'status', 'reset', 'mark']),
    good: z.string().min(1).optional(),
    bad: z.string().min(1).optional(),
    cmd: z.string().min(1).optional(),
    timeout_seconds: z.number().int().positive().max(7200).optional(),
    verdict: z.enum(['good', 'bad', 'skip']).optional(),
    ref: z.string().optional()
  })
);

export function createGitBisectTool({ runUserShell, requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Automated git bisect to localize a regression. `start` runs `git bisect run <cmd>` between known-good and known-bad refs (cmd should exit 0 = good, 1-127 != 125 = bad, 125 = skip). `status` reports current bisect state. `reset` ends the bisect and restores HEAD. All actions require approval.',
    inputSchema: gitBisectInputSchema,
    execute: async rawInput => {
      const input = gitBisectActionSchema.parse(rawInput);
      const cwd = process.cwd();

      if (input.action === 'status') {
        if (!(await isBisectInProgress(cwd))) return 'no bisect in progress';
        const log = await runUserShell('git bisect log');
        const head = await runUserShell('git rev-parse --short HEAD');
        return `bisect in progress · HEAD ${plain(head.output).trim()}\n\n--- log ---\n${truncate(plain(log.output).trim(), 4000) || '(empty)'}`;
      }

      if (input.action === 'reset') {
        if (!(await isBisectInProgress(cwd))) return 'no bisect in progress (nothing to reset)';
        if (
          !(await requestApproval({
            scope: 'command',
            title: 'Reset git bisect',
            detail: 'git bisect reset (restores HEAD)'
          }))
        ) {
          throw new Error('command denied by user');
        }
        const reset = await runUserShell('git bisect reset');
        return reset.exitCode === 0 ? 'bisect reset · HEAD restored' : `error (exit ${reset.exitCode}):\n${plain(reset.output).trim()}`;
      }

      if (input.action === 'mark') {
        if (!(await isBisectInProgress(cwd))) return 'no bisect in progress (run `start` first)';
        const cmd = `git bisect ${input.verdict}${input.ref ? ` ${shellQuote(input.ref)}` : ''}`;
        if (!(await requestApproval({ scope: 'command', title: `Mark bisect ${input.verdict}`, detail: cmd }))) {
          throw new Error('command denied by user');
        }
        const result = await runUserShell(cmd);
        const parsed = parseBisectResult(result.output);
        if (parsed.firstBad) return `first bad commit: ${parsed.firstBad}\n\n${truncate(parsed.raw, 4000)}`;
        return result.exitCode === 0 ? truncate(parsed.raw, 4000) || `(no output)` : `exit ${result.exitCode}:\n${truncate(parsed.raw, 4000)}`;
      }

      // action === 'start'
      if (await isBisectInProgress(cwd)) {
        return 'bisect already in progress · run `reset` first or use `status` / `mark` actions';
      }

      const timeoutSeconds = input.timeout_seconds ?? 1800;
      const timeoutBin = (await runUserShell('command -v timeout || command -v gtimeout || true')).output.trim().split('\n').pop()?.trim();
      const runWrap = timeoutBin
        ? `(${timeoutBin} ${timeoutSeconds}s git bisect run sh -c ${shellQuote(input.cmd)}; echo BISECT_DONE_$?)`
        : `(git bisect run sh -c ${shellQuote(input.cmd)}; echo BISECT_DONE_$?)`;
      const startCmd = [`git bisect start ${shellQuote(input.bad)} ${shellQuote(input.good)}`, runWrap].join(' && ');

      if (
        !(await requestApproval({
          scope: 'command',
          title: 'Start automated git bisect',
          detail: `bad=${input.bad} good=${input.good}\nrun: ${input.cmd}`,
          body: [
            'This will check out commits between the two refs and run the test command at each step.',
            `Timeout: ${timeoutSeconds}s. HEAD will move during bisect — run \`reset\` when finished.`
          ]
        }))
      ) {
        throw new Error('command denied by user');
      }

      const result = await runUserShell(startCmd);
      const parsed = parseBisectResult(result.output);
      const head = await runUserShell('git rev-parse --short HEAD');

      const lines = [
        `bisect ${result.exitCode === 0 ? 'finished' : `exited ${result.exitCode}`}`,
        `HEAD now at ${plain(head.output).trim()}`,
        ''
      ];

      if (parsed.firstBad) {
        lines.push(`✓ first bad commit: ${parsed.firstBad}`);
        const show = await runUserShell(`git show --stat --no-color ${shellQuote(parsed.firstBad)}`);
        lines.push('', '--- commit ---', truncate(plain(show.output).trim(), 4000));
      } else if (parsed.giveUp) {
        lines.push('bisect could not narrow down a single commit (test inconclusive on too many commits).');
      } else {
        const doneMatch = /BISECT_DONE_(\d+)/.exec(parsed.raw);
        if (doneMatch && doneMatch[1] === '124') {
          lines.push(`bisect hit ${timeoutSeconds}s timeout. Inspect with \`status\` or \`reset\`.`);
        }
        if (!timeoutBin) lines.push('(no `timeout`/`gtimeout` on PATH — bisect ran without a wall-clock cap)');
      }

      lines.push('', '--- output ---', truncate(parsed.raw, 6000));
      lines.push('', "tip: run action='reset' to restore HEAD when you're done.");
      return lines.join('\n');
    }
  });
}
