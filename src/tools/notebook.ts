import { readFile, writeFile } from 'node:fs/promises';

import { tool } from 'ai';
import { z } from 'zod';

import { createFileChange, describeFileChange } from '@/file-changes';
import { plain } from '@/text';
import { readOptionalFile, type UndoEntry } from '@/undo';
import type { ToolFactoryOptions } from './types';
import { truncate } from './utils';

type CellType = 'code' | 'markdown' | 'raw';

type NotebookCell = {
  cell_type: CellType;
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
  id?: string;
};

type Notebook = {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
};

function readSource(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

function toJupyterSource(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    if (isLast && parts[i] === '') break;
    out.push(isLast ? parts[i] : `${parts[i]}\n`);
  }
  return out;
}

async function loadNotebook(path: string): Promise<{ raw: string; notebook: Notebook }> {
  const raw = await readFile(path, 'utf8');
  let notebook: Notebook;
  try {
    notebook = JSON.parse(raw) as Notebook;
  } catch (error) {
    throw new Error(
      `failed to parse notebook ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(notebook.cells)) throw new Error(`notebook ${path} has no cells array`);
  return { raw, notebook };
}

function serializeNotebook(notebook: Notebook): string {
  return `${JSON.stringify(notebook, null, 1)}\n`;
}

function previewSource(text: string, maxLines = 6, maxChars = 240) {
  const trimmed = plain(text).trimEnd();
  const lines = trimmed.split('\n');
  const head = lines.slice(0, maxLines).join('\n');
  const truncatedLines =
    lines.length > maxLines
      ? `\n  … ${lines.length - maxLines} more line${lines.length - maxLines === 1 ? '' : 's'}`
      : '';
  const truncatedChars = head.length > maxChars ? `${head.slice(0, maxChars)}…` : head;
  return `${truncatedChars}${truncatedLines}`;
}

function describeOutput(outputs: unknown[] | undefined) {
  if (!outputs || outputs.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const out of outputs) {
    if (typeof out !== 'object' || out === null) continue;
    const kind = (out as Record<string, unknown>).output_type;
    const key = typeof kind === 'string' ? kind : 'other';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([kind, count]) =>
    count > 1 ? `${count}× ${kind}` : kind,
  );
  return parts.join(', ');
}

export function createNotebookReadTool() {
  return tool({
    description:
      'List the cells of a Jupyter notebook (.ipynb): cell index, type, source preview, and a summary of any cached outputs.',
    inputSchema: z.object({
      path: z.string().min(1),
      max_cells: z.number().int().positive().max(500).optional(),
    }),
    execute: async ({ path, max_cells }) => {
      const { notebook } = await loadNotebook(path);
      const limit = max_cells ?? 100;
      const cells = notebook.cells.slice(0, limit);
      const lines: string[] = [
        `${path} · ${notebook.cells.length} cell${notebook.cells.length === 1 ? '' : 's'}`,
      ];

      cells.forEach((cell, index) => {
        const source = readSource(cell);
        const summary = describeOutput(cell.outputs);
        const exec =
          typeof cell.execution_count === 'number' ? ` exec ${cell.execution_count}` : '';
        const outBit = summary ? ` · out: ${summary}` : '';
        lines.push(`\n[${index}] ${cell.cell_type}${exec}${outBit}`);
        const preview = previewSource(source);
        if (preview)
          lines.push(
            preview
              .split('\n')
              .map(line => `  ${line}`)
              .join('\n'),
          );
      });

      if (notebook.cells.length > cells.length) {
        lines.push(
          `\n… ${notebook.cells.length - cells.length} more cell(s) (use max_cells to expand)`,
        );
      }

      return truncate(lines.join('\n'), 12000);
    },
  });
}

export function createNotebookEditTool({ requestApproval, pushUndoEntry }: ToolFactoryOptions) {
  return tool({
    description:
      'Edit a Jupyter notebook (.ipynb) at the cell level: set the source of a cell, insert a new cell, delete a cell, or clear cached outputs. All actions require approval.',
    inputSchema: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('set'),
        path: z.string().min(1),
        index: z.number().int().nonnegative(),
        source: z.string(),
        cell_type: z.enum(['code', 'markdown', 'raw']).optional(),
      }),
      z.object({
        action: z.literal('insert'),
        path: z.string().min(1),
        index: z
          .number()
          .int()
          .nonnegative()
          .describe('Insert position (use cells.length to append).'),
        source: z.string(),
        cell_type: z.enum(['code', 'markdown', 'raw']).default('code'),
      }),
      z.object({
        action: z.literal('delete'),
        path: z.string().min(1),
        index: z.number().int().nonnegative(),
      }),
      z.object({
        action: z.literal('clear_outputs'),
        path: z.string().min(1),
        index: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('If omitted, clears outputs of every code cell.'),
      }),
    ]),
    execute: async input => {
      const { raw, notebook } = await loadNotebook(input.path);

      if (input.action === 'set') {
        if (input.index >= notebook.cells.length)
          throw new Error(`cell index ${input.index} out of range (have ${notebook.cells.length})`);
        const target = notebook.cells[input.index];
        const newType = input.cell_type ?? target.cell_type;
        notebook.cells[input.index] = {
          ...target,
          cell_type: newType,
          source: toJupyterSource(input.source),
          ...(newType === 'code'
            ? { outputs: target.outputs ?? [], execution_count: target.execution_count ?? null }
            : { outputs: undefined, execution_count: undefined }),
        };
      } else if (input.action === 'insert') {
        const cell: NotebookCell = {
          cell_type: input.cell_type,
          source: toJupyterSource(input.source),
          metadata: {},
        };
        if (input.cell_type === 'code') {
          cell.outputs = [];
          cell.execution_count = null;
        }
        const at = Math.min(input.index, notebook.cells.length);
        notebook.cells.splice(at, 0, cell);
      } else if (input.action === 'delete') {
        if (input.index >= notebook.cells.length)
          throw new Error(`cell index ${input.index} out of range (have ${notebook.cells.length})`);
        notebook.cells.splice(input.index, 1);
      } else {
        const targets =
          input.index === undefined ? notebook.cells.map((_, idx) => idx) : [input.index];
        for (const idx of targets) {
          if (idx >= notebook.cells.length)
            throw new Error(`cell index ${idx} out of range (have ${notebook.cells.length})`);
          const cell = notebook.cells[idx];
          if (cell.cell_type !== 'code') continue;
          cell.outputs = [];
          cell.execution_count = null;
        }
      }

      // strip undefined keys so JSON.stringify drops them cleanly
      for (const cell of notebook.cells) {
        if (cell.outputs === undefined) delete cell.outputs;
        if (cell.execution_count === undefined) delete cell.execution_count;
      }

      const nextRaw = serializeNotebook(notebook);
      const previousRaw = await readOptionalFile(input.path);
      const fileChange = createFileChange(input.path, previousRaw, nextRaw);

      if (
        !(await requestApproval({
          scope: 'edit',
          title: 'Edit notebook',
          detail: `${input.path} · ${describeFileChange(fileChange)} (cell ${'index' in input ? (input.index ?? 'all') : 'all'})`,
          fileChanges: [fileChange],
        }))
      ) {
        throw new Error('edit denied by user');
      }

      await writeFile(input.path, nextRaw);
      const undoEntry: UndoEntry = {
        toolName: 'notebook_edit',
        summary: `notebook_edit ${input.action} ${input.path}`,
        files: [{ path: input.path, previousContent: raw, nextContent: nextRaw }],
      };
      pushUndoEntry(undoEntry);

      return `${input.action} ${input.path} · ${describeFileChange(fileChange)} (now ${notebook.cells.length} cell${notebook.cells.length === 1 ? '' : 's'})`;
    },
  });
}
