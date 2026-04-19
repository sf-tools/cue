import { tool } from 'ai';
import { z } from 'zod';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
};

const STATUS_GLYPH: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  cancelled: '[-]',
};

const todos: TodoItem[] = [];

export function getTodos(): TodoItem[] {
  return todos.map(todo => ({ ...todo }));
}

export function clearTodos() {
  todos.length = 0;
}

function renderList(items: TodoItem[]) {
  if (items.length === 0) return '(no todos)';
  return items.map(item => `${STATUS_GLYPH[item.status]} ${item.id}. ${item.content}`).join('\n');
}

function summarize(items: TodoItem[]) {
  const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const item of items) counts[item.status] += 1;
  const total = items.length;
  return `${total} item${total === 1 ? '' : 's'} · ${counts.completed} done · ${counts.in_progress} in progress · ${counts.pending} pending${counts.cancelled ? ` · ${counts.cancelled} cancelled` : ''}`;
}

export function createTodoTool() {
  return tool({
    description:
      'Maintain a structured task list for the current session. Replace the entire list each call (atomic). Mark items in_progress before starting and completed when done. Use for any multi-step task; helps keep work on track and visible to the user.',
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            content: z.string().min(1),
            status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
          }),
        )
        .max(100),
    }),
    execute: async ({ items }) => {
      const seenIds = new Set<string>();
      for (const item of items) {
        if (seenIds.has(item.id)) throw new Error(`duplicate todo id: ${item.id}`);
        seenIds.add(item.id);
      }

      const inProgress = items.filter(item => item.status === 'in_progress').length;
      if (inProgress > 1) throw new Error('only one item may be in_progress at a time');

      todos.length = 0;
      todos.push(...items);

      return `${summarize(todos)}\n\n${renderList(todos)}`;
    },
  });
}
