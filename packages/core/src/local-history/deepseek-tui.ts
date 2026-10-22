import { requireSession } from "./provider-common.js";
import { HistoryFormatError, jsonDocument, record, string, type HistorySession } from "./types.js";

export function parseDeepseek(text: string): HistorySession {
  const root = jsonDocument(text);
  const meta = record(root.metadata);
  if (!Array.isArray(root.messages))
    throw new HistoryFormatError("DeepSeek TUI messages are missing");
  return requireSession({
    id: string(meta.id),
    cwd: string(meta.workspace),
    provider: "deepseek-tui",
    messages: root.messages.map((value, index) => {
      const m = record(value);
      return {
        key: string(m.id) || String(index),
        role: string(m.role),
        content: m.content,
        model: string(m.model) || string(meta.model) || undefined,
        timestamp: string(m.timestamp) || undefined,
        raw: m,
      };
    }),
  });
}
