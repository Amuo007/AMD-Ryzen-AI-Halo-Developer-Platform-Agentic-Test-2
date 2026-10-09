import { setTodos, getTodos } from '../db.js';

export const MAX_TODOS = 50;
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'];

const BOX = { pending: ' ', in_progress: '~', completed: 'x' };

/**
 * todo tool — the agent keeps its multi-step work plan as a checklist.
 * Full-list-replace semantics: every call stores the complete current list.
 * The list is persisted per conversation and pushed to the UI live.
 */
export async function todo(ctx, args = {}) {
  const { sessionId, emit } = ctx;
  if (!Array.isArray(args.todos)) {
    return { ok: false, content: 'Error: todos must be an array of { content, status } objects (the complete list).' };
  }
  if (args.todos.length > MAX_TODOS) {
    return { ok: false, content: `Error: at most ${MAX_TODOS} todo items allowed (got ${args.todos.length}). Merge or drop completed items.` };
  }
  const todos = [];
  for (let i = 0; i < args.todos.length; i++) {
    const t = args.todos[i] ?? {};
    const content = String(t.content ?? '').trim();
    if (!content) return { ok: false, content: `Error: todo #${i + 1} has empty content.` };
    const status = TODO_STATUSES.includes(t.status) ? t.status : 'pending';
    todos.push({ id: String(t.id ?? i + 1), content: content.slice(0, 300), status });
  }
  setTodos(sessionId, todos);
  emit?.({ type: 'todo_update', todos });
  if (todos.length === 0) return { ok: true, content: 'Todo list cleared.' };
  const done = todos.filter((t) => t.status === 'completed').length;
  const lines = todos.map((t) => `${t.id}. [${BOX[t.status]}] ${t.content}`);
  return { ok: true, content: `Todo list updated (${done}/${todos.length} done):\n${lines.join('\n')}` };
}

export { getTodos };
