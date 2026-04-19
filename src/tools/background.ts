import { spawn as spawnPty, type IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { tool } from 'ai';
import { z } from 'zod';

import { USER_SHELL } from '@/config';
import { normalizePtyOutput, plain } from '@/text';
import type { ToolFactoryOptions } from './types';

type BgStatus = 'running' | 'exited' | 'killed';

type BgProcess = {
  id: string;
  cmd: string;
  proc: IPty;
  startedAt: number;
  endedAt: number | null;
  status: BgStatus;
  exitCode: number | null;
  signal: number | null;
  buffer: string;
  cursor: number;
};

const MAX_BUFFER_CHARS = 1_000_000;
const MAX_OUTPUT_CHARS = 6000;

const processes = new Map<string, BgProcess>();
let counter = 0;

function nextId() {
  counter += 1;
  const stamp = Math.floor(Date.now() / 1000).toString(36);
  return `bg_${stamp}_${counter}`;
}

function appendBuffer(record: BgProcess, chunk: string) {
  const next = record.buffer + chunk;
  if (next.length > MAX_BUFFER_CHARS) {
    const trimmed = next.length - MAX_BUFFER_CHARS;
    record.buffer = next.slice(trimmed);
    record.cursor = Math.max(0, record.cursor - trimmed);
  } else {
    record.buffer = next;
  }
}

function describe(record: BgProcess) {
  const elapsed = ((record.endedAt ?? Date.now()) - record.startedAt) / 1000;
  const status =
    record.status === 'running'
      ? 'running'
      : record.status === 'exited'
        ? `exited code ${record.exitCode ?? '?'}`
        : `killed${record.signal !== null ? ` (signal ${record.signal})` : ''}`;
  return `${record.id} · ${status} · ${elapsed.toFixed(1)}s · pid ${record.proc.pid}`;
}

export function createBashBgTool({ requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Start a long-running shell command in the background (dev server, watcher, etc.). Returns an `id` you pass to `bash_output` and `bash_kill`. Output is buffered and survives across tool calls.',
    inputSchema: z.object({
      cmd: z.string().min(1).describe('Shell command to run in the background.')
    }),
    execute: async ({ cmd }) => {
      const trimmed = cmd.trim() || cmd;
      if (!(await requestApproval({ scope: 'command', title: 'Start background command', detail: trimmed }))) {
        throw new Error('command denied by user');
      }

      const proc = spawnPty(USER_SHELL, ['-ic', cmd], {
        name: 'xterm-256color',
        cols: Math.floor(process.stdout.columns / 1.5) || 120,
        rows: Math.floor(process.stdout.rows / 1.5) || 30,
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: process.env.COLORTERM || 'truecolor',
          FORCE_COLOR: process.env.FORCE_COLOR || '1',
          CLICOLOR: process.env.CLICOLOR || '1',
          CLICOLOR_FORCE: process.env.CLICOLOR_FORCE || '1'
        }
      });

      const record: BgProcess = {
        id: nextId(),
        cmd,
        proc,
        startedAt: Date.now(),
        endedAt: null,
        status: 'running',
        exitCode: null,
        signal: null,
        buffer: '',
        cursor: 0
      };

      proc.onData(data => {
        appendBuffer(record, normalizePtyOutput(data));
      });

      proc.onExit(({ exitCode, signal }) => {
        record.endedAt = Date.now();
        record.exitCode = exitCode;
        record.signal = signal ?? null;
        record.status = record.status === 'killed' ? 'killed' : 'exited';
      });

      processes.set(record.id, record);
      return `started ${describe(record)}\ncmd: ${trimmed}`;
    }
  });
}

export function createBashOutputTool() {
  return tool({
    description:
      'Read buffered output from a background command started with `bash_bg`. By default returns only new output since the last read; pass `from_start: true` to re-read everything. Also reports current status.',
    inputSchema: z.object({
      id: z.string().min(1),
      from_start: z.boolean().optional(),
      tail: z.number().int().positive().max(20000).optional().describe('Return only the last N chars of the requested slice.')
    }),
    execute: async ({ id, from_start, tail }) => {
      const record = processes.get(id);
      if (!record) return `error: no background process with id ${id}`;

      const start = from_start ? 0 : record.cursor;
      let slice = record.buffer.slice(start);
      record.cursor = record.buffer.length;

      if (tail && slice.length > tail) slice = slice.slice(-tail);
      const cleaned = plain(slice);
      const trimmed = cleaned.length > MAX_OUTPUT_CHARS ? `…\n${cleaned.slice(-MAX_OUTPUT_CHARS)}` : cleaned;

      const header = describe(record);
      if (!trimmed.trim()) return `${header}\n(no new output)`;
      return `${header}\n---\n${trimmed.trimEnd()}`;
    }
  });
}

export function createBashKillTool() {
  return tool({
    description: 'Kill a background command started with `bash_bg`. Sends SIGTERM, then SIGKILL after a short grace period if still running.',
    inputSchema: z.object({
      id: z.string().min(1)
    }),
    execute: async ({ id }) => {
      const record = processes.get(id);
      if (!record) return `error: no background process with id ${id}`;
      if (record.status !== 'running') return `${describe(record)}\n(already stopped)`;

      record.status = 'killed';
      try {
        record.proc.kill('SIGTERM');
      } catch (error) {
        return `error sending SIGTERM: ${error instanceof Error ? error.message : String(error)}`;
      }

      const settled = await new Promise<boolean>(resolve => {
        const timeout = setTimeout(() => resolve(false), 1500);
        const handle = record.proc.onExit(() => {
          clearTimeout(timeout);
          handle.dispose();
          resolve(true);
        });
      });

      if (!settled) {
        try {
          record.proc.kill('SIGKILL');
        } catch {
          // ignore — already gone
        }
      }

      return `killed ${describe(record)}`;
    }
  });
}

export function listBackgroundProcesses() {
  return [...processes.values()].map(record => ({
    id: record.id,
    cmd: record.cmd,
    status: record.status,
    pid: record.proc.pid,
    startedAt: record.startedAt,
    endedAt: record.endedAt
  }));
}
