import { HistoryFormatError, jsonLines, string, type HistorySession } from "./types.js";

// Zencoder's observed transcript has a session header, then role/content rows.
// Only producer system context is accepted as workspace evidence.
export function parseZencoder(text: string): HistorySession {
  const [header, ...rows] = jsonLines(text);
  if (!header || !string(header.id)) throw new HistoryFormatError("Zencoder session header is missing");
  const session: HistorySession = { id: string(header.id), provider: "zencoder", cwd: "", messages: [] };
  if (["directContinuation", "summarizedContinuation", "summarizationRequest"].includes(string(header.creationReason)) && string(header.parentId)) {
    session.metadata = { continuationOf: header.parentId, creationReason: header.creationReason };
  }
  for (const [index, row] of rows.entries()) {
    const role = string(row.role);
    if (role === "system" && typeof row.content === "string") {
      session.cwd ||= /^Working directory:\s+(.+)$/m.exec(row.content)?.[1].trim() || "";
    }
    if (!["user", "assistant", "tool", "system", "finish"].includes(role)) continue;
    session.messages.push({
      key: string(row.id) || String(index), role: role === "finish" ? "system" : role,
      content: row.content ?? { reason: row.reason },
      timestamp: string(row.createdAt) || undefined,
      raw: row,
    });
  }
  if (!session.cwd) throw new HistoryFormatError("Zencoder workspace evidence is missing");
  return session;
}
