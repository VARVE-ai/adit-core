import type Database from "better-sqlite3";
import { record, string, type HistoryMessage, type HistorySession } from "./types.js";

export function isHistoryPrompt(message: HistoryMessage): boolean {
  return message.role === "user" && !(Array.isArray(message.content) && message.content.length > 0 &&
    message.content.every(block => ["tool_result", "toolResult", "function_call_output", "custom_tool_call_output"].includes(string(record(block).type))));
}

export function replaceTextBlock(block: unknown, text: string): unknown {
  if (typeof block === "string") return text;
  const value = record(block);
  return { ...value, [typeof value.text === "string" ? "text" : "content"]: text };
}

/** Reapply local changes by native identity; a later collection cannot restore deleted turns. */
export function applyTranscriptEdits(db: Database.Database, session: HistorySession): HistorySession {
  const deleted = new Set((db.prepare("SELECT prompt_key FROM adit_history_deleted_turns WHERE provider=? AND session_id=?")
    .all(session.provider, session.id) as { prompt_key: string }[]).map(r => r.prompt_key));
  const edits = db.prepare("SELECT message_key,block_index,text_content FROM adit_history_text_edits WHERE provider=? AND session_id=?")
    .all(session.provider, session.id) as { message_key: string; block_index: number; text_content: string }[];
  if (!deleted.size && !edits.length) return session;
  const byMessage = new Map<string, typeof edits>();
  for (const edit of edits) byMessage.set(edit.message_key, [...(byMessage.get(edit.message_key) || []), edit]);
  let omit = false;
  const messages: HistoryMessage[] = [];
  for (const message of session.messages) {
    if (isHistoryPrompt(message)) omit = deleted.has(message.key);
    if (omit) continue;
    const changes = byMessage.get(message.key);
    if (!changes) { messages.push(message); continue; }
    const blocks = Array.isArray(message.content) ? [...message.content] : [message.content];
    for (const edit of changes) {
      const block = blocks[edit.block_index];
      if (typeof block === "string" || ["text", "input_text", "output_text"].includes(string(record(block).type)))
        blocks[edit.block_index] = replaceTextBlock(block, edit.text_content);
    }
    messages.push({ ...message, content: Array.isArray(message.content) ? blocks : blocks[0] });
  }
  return { ...session, messages };
}
