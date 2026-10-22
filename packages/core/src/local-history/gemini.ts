import { requireSession } from "./provider-common.js";
import { HistoryFormatError, jsonDocument, jsonLines, record, string, type HistoryMessage, type HistorySession } from "./types.js";

export function parseGemini(text: string, cwd: string): HistorySession {
  let root: Record<string, unknown> = {};
  try {
    root = jsonDocument(text);
  } catch {
    /* An append-only log is not one JSON document. */
  }
  if (!Array.isArray(root.messages)) {
    const records: Record<string, unknown>[] = [];
    const positions = new Map<string, number>();
    let sessionId = "", summary = "";
    for (const row of jsonLines(text)) {
      if (row.sessionId) {
        if (sessionId && sessionId !== row.sessionId)
          throw new HistoryFormatError(
            "Multiple Gemini session identities in one source",
          );
        sessionId = string(row.sessionId);
        if (typeof row.summary === "string") summary = row.summary;
      }
      const update = record(row.$set);
      if (typeof update.summary === "string") summary = update.summary;
      if (row.type !== "user" && row.type !== "gemini") continue;
      const id = string(row.id),
        existing = id ? positions.get(id) : undefined;
      if (existing !== undefined) records[existing] = row;
      else {
        if (id) positions.set(id, records.length);
        records.push(row);
      }
    }
    root = { sessionId, summary, messages: records };
  }
  const messages: HistoryMessage[] = [];
  let previousInput = 0,
    previousCached = 0;
  for (const value of root.messages as unknown[]) {
    const m = record(value);
    if (m.type !== "user" && m.type !== "gemini") continue;
    const role = m.type === "gemini" ? "assistant" : string(m.type);
    const tokens = record(m.tokens);
    messages.push({
      key: string(m.id) || String(messages.length),
      role,
      content: m.content,
      model: string(m.model) || undefined,
      timestamp: string(m.timestamp) || undefined,
      usage: Object.keys(tokens).length
        ? {
            input_tokens:
              Number(tokens.input || 0) >= previousInput
                ? Number(tokens.input || 0) - previousInput
                : Number(tokens.input || 0),
            output_tokens:
              Number(tokens.output || 0) + Number(tokens.thoughts || 0),
            cache_read_input_tokens:
              Number(tokens.cached || 0) >= previousCached
                ? Number(tokens.cached || 0) - previousCached
                : Number(tokens.cached || 0),
          }
        : undefined,
      raw: m,
    });
    if (tokens.input !== undefined || tokens.cached !== undefined) {
      previousInput = Number(tokens.input || 0);
      previousCached = Number(tokens.cached || 0);
    }
  }
  return requireSession({
    id: string(root.sessionId),
    provider: "gemini",
    cwd,
    metadata: { title: string(root.summary).trim() },
    messages,
  });
}
