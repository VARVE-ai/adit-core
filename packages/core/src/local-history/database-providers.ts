import { dirname, basename } from "node:path";
import { databaseSnapshot, hasTable, timestamp } from "./source-io.js";
import { array, decode, first, group, message, session, sorted, table, type Row } from "./provider-common.js";
import { record, string, type HistorySession } from "./types.js";

export const databaseProviders = ["goose", "hermes", "augure-desktop", "forge", "shelley", "crush", "zcode"];

export function readDatabaseProvider(path: string, provider: string, signal?: AbortSignal): HistorySession[] {
  return databaseSnapshot(path, db => {
    signal?.throwIfAborted();
    if (provider === "forge") {
      return table(db, "conversations", ["conversation_id", "title", "context", "metrics"], ["conversation_id", "context"]).map(row => {
        const context = record(decode(row.context));
        let cwd = "";
        const messages = array(context.messages).map((item, index) => {
          const wire = record(item.message), text = record(wire.text), tool = record(wire.tool);
          const content = text.content ?? record(text.raw_content).Text;
          cwd ||= /<current_working_directory>\s*([\s\S]*?)\s*<\/current_working_directory>/.exec(string(content))?.[1] || "";
          return message(text, index, { role: string(text.role).toLowerCase() || "tool", content: Object.keys(tool).length ? tool : { content, reasoning_details: text.reasoning_details, tool_calls: text.tool_calls }, usage: Object.keys(record(item.usage)).length ? record(item.usage) : undefined, raw: item });
        });
        return session(provider, row.conversation_id, cwd, messages, { title: row.title, usage: decode(row.metrics) });
      });
    }
    if (provider === "shelley") {
      const messages = group(sorted(table(db, "messages", ["conversation_id", "sequence_id", "type", "llm_data", "user_data", "usage_data", "created_at"], ["conversation_id", "sequence_id", "llm_data"]), "sequence_id"), "conversation_id");
      return table(db, "conversations", ["conversation_id", "slug", "cwd", "model", "parent_conversation_id", "user_initiated"], ["conversation_id", "cwd"]).map(row => {
        const result = session(provider, row.conversation_id, row.cwd, (messages.get(row.conversation_id) || []).map((m, i) => {
          const data = record(decode(m.llm_data)), usage = record(decode(m.usage_data));
          return message(m, i, { role: m.type === "agent" ? "assistant" : m.type === "tool" ? "tool" : m.type === "user" ? "user" : "system", content: data.Content ?? decode(m.user_data, ""), model: string(usage.model) || string(row.model) || undefined, usage: Object.keys(usage).length ? usage : undefined });
        }), { title: row.slug });
        if (row.user_initiated === 0 && string(row.parent_conversation_id)) { result.parentId = string(row.parent_conversation_id); result.relationship = "subagent"; }
        return result;
      });
    }
    if (provider === "zcode") {
      const messages = group(sorted(table(db, "message", ["id", "session_id", "data", "time_created"], ["session_id", "data"]), "time_created", "id"), "session_id");
      const parts = hasTable(db, "part") ? group(sorted(table(db, "part", ["id", "message_id", "session_id", "data", "time_created"], ["message_id", "data"]), "time_created", "id"), "message_id") : new Map<unknown, Row[]>();
      const usage = hasTable(db, "model_usage") ? group(table(db, "model_usage", ["session_id", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "completed_at"], ["session_id"]), "session_id") : new Map<unknown, Row[]>();
      return table(db, "session", ["id", "directory", "title"], ["id", "directory"]).map(row => session(provider, row.id, row.directory, (messages.get(row.id) || []).map((m, i) => {
        const data = record(decode(m.data));
        return message(data, i, { key: string(m.id), content: data.content ?? (parts.get(m.id) || []).map(p => decode(p.data)), timestamp: string(m.time_created) || undefined, raw: { ...data, parts: (parts.get(m.id) || []).map(p => decode(p.data)) } });
      }), { title: row.title, usage: usage.get(row.id) }));
    }
    const hermes = ["hermes", "augure-desktop"].includes(provider);
    const goose = provider === "goose";
    const fields = ["id", "name", "title", ...(goose ? ["description"] : []), "working_dir", "parent_session_id", "model", "model_config_json", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "accumulated_input_tokens", "accumulated_output_tokens", "accumulated_cache_read_tokens", "accumulated_cache_write_tokens", "prompt_tokens", "completion_tokens"];
    const messageFields = hermes
      ? ["id", "session_id", "role", "content", "tool_calls", "tool_call_id", "timestamp", "reasoning", "reasoning_content", "reasoning_details", "finish_reason", "codex_reasoning_items", "codex_message_items"]
      : goose ? ["id", "message_id", "session_id", "role", "content_json", "metadata_json", "timestamp", "created_timestamp"]
        : ["id", "session_id", "role", "parts", "model", "created_at", "is_summary_message"];
    const messages = group(sorted(table(db, "messages", messageFields, ["session_id", "role", hermes ? "content" : goose ? "content_json" : "parts"]), goose ? "created_timestamp" : hermes ? "timestamp" : "created_at", "id"), "session_id");
    return table(db, "sessions", fields, ["id", ...(goose ? ["working_dir"] : [])]).map(row => {
      signal?.throwIfAborted();
      const native = messages.get(row.id) || [];
      const selected = goose ? native.filter(m => record(decode(m.metadata_json)).userVisible !== false) : native;
      let cwd = string(row.working_dir);
      if (provider === "crush" && basename(dirname(path)) === ".crush") cwd = dirname(dirname(path));
      const result = session(provider, row.id, cwd, selected.map((m, i) => message(m, i, {
        key: string(m.message_id) || String(m.id),
        content: goose ? decode(m.content_json, []) : hermes ? { content: m.content, tool_calls: decode(m.tool_calls, []), tool_call_id: m.tool_call_id, reasoning: m.reasoning, reasoning_content: m.reasoning_content, reasoning_details: m.reasoning_details, codex_reasoning_items: decode(m.codex_reasoning_items, []), codex_message_items: decode(m.codex_message_items, []) } : decode(m.parts, []),
        model: string(m.model) || string(row.model) || first(decode(row.model_config_json), "model_name", "model") || undefined,
        timestamp: timestamp(provider === "crush" && typeof m.created_at === "number" ? m.created_at * 1000 : m.timestamp ?? m.created_timestamp ?? m.created_at),
      })), { title: goose ? string(row.name).trim() || string(row.description).trim() : row.title ?? row.name, usage: Object.fromEntries(Object.entries(row).filter(([k]) => /tokens$/.test(k))) });
      if (hermes && string(row.parent_session_id)) result.metadata!.continuationOf = row.parent_session_id;
      if (goose && string(row.parent_session_id)) { result.parentId = string(row.parent_session_id); result.relationship = "subagent"; }
      if (provider === "crush" && string(row.parent_session_id)) { result.parentId = string(row.parent_session_id); result.relationship = "subagent"; }
      return result;
    });
  });
}
