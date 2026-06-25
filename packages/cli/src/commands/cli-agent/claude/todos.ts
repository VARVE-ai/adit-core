import { asRecord, readString } from "./sdk-messages.js";

export type ClaudeTodoStatus = "pending" | "in_progress" | "completed";

export type ClaudeTodoPriority = "high" | "medium" | "low";

export interface ClaudeTodoItem {
  id: string;
  content: string;
  status: ClaudeTodoStatus;
  priority?: ClaudeTodoPriority;
  activeForm?: string;
}

export function readTodoStatus(value: unknown): ClaudeTodoStatus | null {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : null;
}

export function readTodoPriority(value: unknown): ClaudeTodoPriority | null {
  return value === "high" || value === "medium" || value === "low" ? value : null;
}

export function normalizeClaudeTodoWriteInput(input: unknown): ClaudeTodoItem[] | null {
  const rawTodos = asRecord(input).todos;
  if (!Array.isArray(rawTodos)) return null;
  if (rawTodos.length === 0) return [];

  const todos: ClaudeTodoItem[] = [];
  rawTodos.forEach((item, index) => {
    const todo = asRecord(item);
    const content = readString(todo.content) ?? readString(todo.title) ?? readString(todo.task);
    if (!content) return;
    const priority = readTodoPriority(todo.priority);
    const activeForm = readString(todo.activeForm);
    todos.push({
      id: readString(todo.id) ?? `todo-${index}`,
      content,
      status: readTodoStatus(todo.status) ?? "pending",
      ...(priority ? { priority } : {}),
      ...(activeForm ? { activeForm } : {}),
    });
  });

  return todos.length > 0 ? todos : null;
}
