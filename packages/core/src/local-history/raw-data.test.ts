import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { compactHistoryRaw, restoreHistoryRaw } from "./raw-data.js";
import { createHistorySchema } from "./schema.js";
import { StructuredHistory, historyKey } from "./structured-store.js";
import { historyFinalReply, nativeContextKind } from "./message-semantics.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const text = '中文\r\n"quoted" 😀 \\'.repeat(30);

it.each([
  { content: text, raw: { uuid: "id", content: text, phase: "final", unknown: { retained: true } } },
  { content: text, raw: { uuid: "id", message: { id: "response", content: text, stop_reason: "end_turn" } } },
  { content: [{ type: "output_text", text }], raw: { payload: { type: "message", content: [{ type: "output_text", text }], phase: "final" } } },
  { content: text, raw: { payload: { type: "function_call_output", call_id: "tool", output: text } } },
  { content: text, raw: { payload: { type: "function_call", arguments: text, name: "exec_command" } } },
  { content: [{ type: "summary_text", text }], raw: { payload: { summary: [{ type: "summary_text", text }], encrypted_content: "retained" } } },
  { content: { text, nested: [null, false, 0, "", ["array"]] }, raw: { data: { message: { content: { text, nested: [null, false, 0, "", ["array"]] } } } } },
  { content: text, raw: { content: text, message: { content: text }, text } },
])("restores exact JSON ordering and metadata for $raw", ({ content, raw }) => {
  const rawJson = JSON.stringify(raw);
  const compacted = compactHistoryRaw(rawJson, JSON.stringify(content));
  expect(compacted.pathsJson).not.toBeNull();
  expect(compacted.rawJson).not.toContain(text);
  expect(JSON.stringify(restoreHistoryRaw(compacted.rawJson, content, compacted.pathsJson))).toBe(rawJson);
  expect(historyKey(restoreHistoryRaw(compacted.rawJson, content, compacted.pathsJson))).toBe(historyKey(raw));
  expect(raw).toEqual(JSON.parse(rawJson));
});

it("does not share mutable objects between parsed content and restored originals", () => {
  const content = [{ type: "text", text }];
  const compacted = compactHistoryRaw(JSON.stringify({ content, message: { content } }), JSON.stringify(content));
  const raw = restoreHistoryRaw(compacted.rawJson, content, compacted.pathsJson) as { content: typeof content; message: { content: typeof content } };
  raw.content[0].text = "changed raw";
  expect(content[0].text).toBe(text);
  expect(raw.message.content[0].text).toBe(text);
});

it("leaves oversized new originals intact without parsing additional large JSON objects", () => {
  const content = JSON.stringify("large".repeat(2 * 1024 * 1024));
  const rawJson = `{"content":${content}}`;
  expect(compactHistoryRaw(rawJson, content)).toEqual({ rawJson, pathsJson: null });
});

it.each([
  { metadata: { compaction_output: true }, payload: { content: text, phase: "final_answer" } },
  { payload: { content: text, internal_chat_message_metadata_passthrough: { content_item_kinds: ["generic.turn_aborted"] } } },
  { payload: { content: text, phase: "analysis", stop_reason: "tool_use" } },
])("keeps context and completion metadata directly queryable without raw reconstruction", raw => {
  const compacted = compactHistoryRaw(JSON.stringify(raw), JSON.stringify(text));
  expect(compacted.pathsJson).not.toBeNull();
  const stored = JSON.parse(compacted.rawJson);
  expect(nativeContextKind("codex", stored)).toBe(nativeContextKind("codex", raw));
  const { content: originalContent, ...metadata } = raw.payload;
  expect(originalContent).toBe(text);
  expect(stored.payload).toEqual({ ...metadata, content: null });
});

it.each([
  { rawJson: "broken", contentJson: JSON.stringify(text) },
  { rawJson: JSON.stringify({ content: text }), contentJson: "broken".repeat(30) },
  { rawJson: JSON.stringify({ content: text }), contentJson: JSON.stringify(text + "edited") },
  { rawJson: JSON.stringify({ content: text }), contentJson: null },
  { rawJson: '{"content":"short"}', contentJson: '"short"' },
  { rawJson: JSON.stringify({ content: text }, null, 2), contentJson: JSON.stringify(text) },
  { rawJson: JSON.stringify({ phase: text, metadata: { content: text }, unknown: text }), contentJson: JSON.stringify(text) },
  { rawJson: JSON.stringify({ content: [text, "extra"] }), contentJson: JSON.stringify([text]) },
])("retains distinct, noncanonical, small and malformed originals: $rawJson", ({ rawJson, contentJson }) => {
  expect(compactHistoryRaw(rawJson, contentJson)).toEqual({ rawJson, pathsJson: null });
});

it("rejects invalid references instead of inventing original content", () => {
  for (const paths of [[], [["__proto__", "content"]], [["payload", "phase"]], [["content"], ["content"]]])
    expect(() => restoreHistoryRaw('{"content":null}', text, JSON.stringify(paths))).toThrow("Invalid history raw content reference");
  expect(() => restoreHistoryRaw('{"content":null}', undefined, '[["content"]]')).toThrow();
  expect(() => restoreHistoryRaw('{"content":"unique"}', text, '[["content"]]')).toThrow();
});

it("writes compact originals while preserving reads, digests, native reply semantics and tool evidence", () => {
  const database = new Database(":memory:");
  databases.push(database);
  createHistorySchema(database);
  const content = [{ type: "output_text", text }];
  const messages = [
    { key: "prompt", role: "user", content: text, raw: { uuid: "prompt", message: { content: text } } },
    { key: "tool", role: "assistant", content: JSON.stringify({ cmd: text }), raw: { payload: {
      type: "function_call", name: "exec_command", call_id: "call", arguments: JSON.stringify({ cmd: text }),
    } } },
    { key: "result", role: "tool", content: text, raw: { payload: { type: "function_call_output", call_id: "call", output: text } } },
    { key: "answer", role: "assistant", content, raw: { payload: { type: "message", role: "assistant", content, phase: "final" } } },
  ];
  const session = { provider: "codex", id: "session", cwd: "/fixture", messages };
  const history = new StructuredHistory(database);
  history.write(session);
  expect(history.read("codex", "session")).toEqual(session);
  const stored = database.prepare("SELECT raw_content_paths_json FROM adit_history_messages").all() as { raw_content_paths_json: string | null }[];
  expect(stored.every(row => row.raw_content_paths_json !== null)).toBe(true);
  expect(database.prepare("SELECT digest FROM adit_history_message_digests ORDER BY rowid").all()).toEqual(messages.map(message => ({ digest: historyKey(message) })));
  const turn = database.prepare("SELECT id FROM adit_history_turns").get() as { id: string };
  expect(historyFinalReply(database, turn.id, false)?.id).toBe(historyKey("codex", "session", "answer"));
  expect(database.prepare("SELECT input_json FROM adit_history_tool_calls").get()).toEqual({ input_json: JSON.stringify(JSON.stringify({ cmd: text })) });
  expect(database.prepare("SELECT content_text,content_json FROM adit_history_tool_results").get()).toEqual({ content_text: text, content_json: JSON.stringify(text) });
  const before = database.prepare("SELECT * FROM adit_history_messages").all();
  history.write(history.read("codex", "session")!);
  expect(database.prepare("SELECT * FROM adit_history_messages").all()).toEqual(before);
});

it("adds only a nullable reference column to legacy message rows without changing stored data", () => {
  const database = new Database(":memory:");
  databases.push(database);
  createHistorySchema(database);
  new StructuredHistory(database).write({ provider: "claude", id: "session", cwd: "/fixture", messages: [
    { key: "prompt", role: "user", content: "short", raw: { content: "short" } },
  ] });
  database.exec("ALTER TABLE adit_history_messages DROP COLUMN raw_content_paths_json");
  const previous = database.prepare("SELECT * FROM adit_history_messages").all();
  createHistorySchema(database);
  createHistorySchema(database);
  expect(database.prepare("SELECT * FROM adit_history_messages").all()).toEqual(previous.map(row => ({ ...row as object, raw_content_paths_json: null })));
});
