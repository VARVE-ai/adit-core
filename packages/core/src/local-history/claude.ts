import { basename, dirname } from "node:path";
import { requireSession } from "./provider-common.js";
import { HistoryFormatError, jsonLines, record, string, type HistoryMessage, type HistorySession } from "./types.js";

export function parseClaude(text: string, path: string, options: { linear?: boolean } = {}): HistorySession {
  const fileId = basename(path, ".jsonl");
  const isChild =
    fileId.startsWith("agent-") || basename(dirname(path)) === "subagents";
  const session: HistorySession = {
    id: isChild ? fileId : "",
    provider: "claude",
    cwd: "",
    messages: [],
  };
  const ids = new Map<string, number>();
  const responseGroups = new Map<string, number>();
  const children = new Map<string, Set<string>>();
  for (const row of jsonLines(text)) {
    session.cwd ||= string(row.cwd);
    if (!session.id) session.id = string(row.sessionId);
    if (isChild && row.sessionId) session.parentId = string(row.sessionId);
    if (row.type !== "user" && row.type !== "assistant") continue;
    const payload = record(row.message);
    const key = string(row.uuid) || `line:${session.messages.length}`;
    const parentKey = string(row.parentUuid);
    // The lineage reader may explicitly retain an incomplete graph in file order.
    if (parentKey && !options.linear) {
      const branches = children.get(parentKey) ?? new Set<string>();
      branches.add(key);
      children.set(parentKey, branches);
      if (branches.size > 1)
        throw new HistoryFormatError(
          "Claude branched history requires lineage handling; existing data was retained",
        );
    }
    const message: HistoryMessage = {
      key,
      role: string(row.type),
      timestamp: string(row.timestamp) || undefined,
      model: string(payload.model) || undefined,
      content: payload.content,
      parentKey: parentKey || undefined,
      usage: payload.usage ? record(payload.usage) : undefined,
      raw: row,
    };
    const responseId = row.type === "assistant" ? string(payload.id) : "";
    const group = responseId ? `${responseId}:${string(row.requestId)}` : "";
    const existing =
      ids.get(key) ?? (group ? responseGroups.get(group) : undefined);
    if (existing === undefined) {
      ids.set(key, session.messages.length);
      if (group) responseGroups.set(group, session.messages.length);
      session.messages.push(message);
    } else {
      const previous = session.messages[existing];
      // Streamed response blocks share a message ID; final metadata owns usage.
      if (
        previous.key !== key &&
        Array.isArray(previous.content) &&
        Array.isArray(message.content)
      ) {
        message.content = [...previous.content, ...message.content];
      }
      session.messages[existing] = { ...message, key: previous.key };
      ids.set(key, existing);
    }
  }
  return requireSession(session);
}
