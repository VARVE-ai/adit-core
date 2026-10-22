import { basename, dirname, join } from "node:path";
import { readSourceJSON, readSource, timestamp } from "./source-io.js";
import { HistoryFormatError, jsonLines, record, string, type HistorySession } from "./types.js";

export const sidecarProviders = ["cline", "vibe"];

export async function readSidecarSession(path: string, provider: string, signal?: AbortSignal): Promise<HistorySession[]> {
  const dir = dirname(path);
  const metadata = await readSourceJSON(path, signal);
  const cline = provider === "cline";
  const id = string(metadata.session_id) || basename(dir);
  const cwd = cline ? string(metadata.cwd) || string(metadata.workspace_root) : string(metadata.working_dir) || string(record(metadata.environment).working_directory);
  if (!cwd) throw new HistoryFormatError("Session workspace evidence is missing");
  let transcript: Record<string, unknown>[];
  let origin: Record<string, unknown> = {};
  if (cline) {
    const document = await readSourceJSON(join(dir, `${basename(dir)}.messages.json`), signal);
    if (document.sessionId && document.sessionId !== id) throw new HistoryFormatError("Cline metadata and transcript identities differ");
    if (!Array.isArray(document.messages)) throw new HistoryFormatError("Cline transcript messages are missing");
    transcript = document.messages.map(record);
    origin = record(document.origin);
  } else transcript = jsonLines((await readSource(join(dir, "messages.jsonl"), signal)).toString("utf8"));
  const parentId = cline ? string(origin.parentThreadId) : string(metadata.parent_session_id);
  return [{
    id, provider, cwd, parentId: parentId || undefined,
    relationship: parentId ? "subagent" : undefined,
    metadata: {
      title: cline ? record(metadata.metadata).title : metadata.title,
      usage: cline ? record(metadata.metadata).aggregateUsage ?? record(metadata.metadata).usage : metadata.stats,
    },
    messages: transcript.flatMap((row, index) => {
      signal?.throwIfAborted();
      const role = string(row.role);
      if (!["user", "assistant", "system", "tool"].includes(role)) return [];
      const usage = cline ? record(row.metrics) : {};
      return [{
        key: string(row.id) || string(row.message_id) || String(index),
        role, content: cline ? row.content : { content: row.content, reasoning_content: row.reasoning_content, tool_calls: row.tool_calls, tool_call_id: row.tool_call_id },
        model: string(record(row.modelInfo).id) || string(row.model) || string(metadata.model) || string(record(metadata.config).active_model) || undefined,
        timestamp: timestamp(row.ts ?? row.timestamp),
        usage: Object.keys(usage).length ? usage : undefined,
        raw: row,
      }];
    }),
  }];
}
