import { basename } from "node:path";
import { HistoryFormatError, jsonLines, record, string, type HistoryMessage, type HistorySession } from "./types.js";

// Format evidence: Qwen chatRecordingService/sessionStorageUtils;
// OpenClaude sessionStorage; Command Code's observed project transcript format.
// Keep the wire objects intact so tools, thoughts and unrecognized fields survive.
export function parseProjectJSONL(text: string, provider: string, path: string, metadata: Record<string, unknown> = {}): HistorySession {
  const rows = jsonLines(text);
  const session: HistorySession = { id: "", provider, cwd: "", messages: [] };
  const positions = new Map<string, number>();
  let pending: HistoryMessage | undefined;
  const flush = () => {
    if (pending) session.messages.push(pending);
    pending = undefined;
  };
  for (const [line, row] of rows.entries()) {
    const id = string(row.sessionId);
    if (id && session.id && id !== session.id)
      throw new HistoryFormatError("Multiple session identities in one project transcript");
    session.id ||= id;
    const meta = record(row.metadata);
    session.cwd ||= string(row.cwd) || (provider === "commandcode" ? string(meta.projectPath) || string(record(meta.context).cwd) : "");
    const payload = provider === "commandcode" ? row : record(row.message);
    const role = provider === "qwen"
      ? row.type === "assistant" && payload.role === "model" ? "assistant" : row.type === "user" && payload.role === "user" ? "user" : ""
      : string(payload.role) || string(row.type);
    if (!["user", "assistant", "system", "tool"].includes(role) || row.isMeta === true) continue;
    const content = provider === "qwen" ? payload.parts : payload.content;
    if (content === undefined) continue;
    const usage = provider === "qwen" ? record(row.usageMetadata) : provider === "openclaude" ? record(payload.usage) : {};
    const message: HistoryMessage = {
      key: string(row.uuid) || string(payload.id) || `line:${line}`,
      role, content, raw: row,
      timestamp: string(row.timestamp) || undefined,
      model: string(row.model) || string(payload.model) || undefined,
      parentKey: string(row.parentUuid) || undefined,
      usage: Object.keys(usage).length ? usage : undefined,
    };
    if (provider === "qwen") {
      const parts = Array.isArray(content) ? content.map(record) : [];
      const hasText = parts.some(p => !p.thought && string(p.text).trim());
      const hasCall = parts.some(p => p.functionCall);
      if (role === "assistant" || (role === "user" && !hasText && parts.some(p => p.functionResponse))) {
        if (!pending) pending = { ...message, role: "assistant", content: [], usage: undefined, raw: { records: [] } };
        pending.content = [...pending.content as unknown[], ...parts];
        (pending.raw.records as unknown[]).push(row);
        pending.model = message.model || pending.model;
        if (message.usage) {
          const totals = pending.usage ||= {};
          for (const [key, value] of Object.entries(message.usage)) {
            if (typeof value === "number" && Number.isFinite(value)) totals[key] = Number(totals[key] || 0) + value;
          }
        }
        if (role === "assistant" && hasText && !hasCall) flush();
        continue;
      }
      flush();
    }
    const prior = positions.get(message.key);
    if (prior === undefined) {
      positions.set(message.key, session.messages.length);
      session.messages.push(message);
    } else session.messages[prior] = message;
  }
  flush();
  session.id ||= basename(path, ".jsonl");
  session.cwd ||= provider === "commandcode" ? string(metadata.projectPath) || string(metadata.cwd) : "";
  if (!session.id || !session.cwd) throw new HistoryFormatError("Session identity or workspace evidence is missing");
  return session;
}
