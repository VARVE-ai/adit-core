import { basename, dirname } from "node:path";
import { requireSession } from "./provider-common.js";
import { HistoryFormatError, jsonLines, record, string, type HistoryMessage, type HistorySession } from "./types.js";

/** Native title events are session metadata, including when the transcript branches. */
export function claudeSessionTitle(rows: Iterable<Record<string, unknown>>, compatible = false): string {
  let generated = "", renamed: string | undefined;
  let custom = "", sessionName = "";
  for (const row of rows) {
    if (compatible) sessionName ||= string(row.sessionName).trim();
    if (row.type === "ai-title" && string(row.aiTitle).trim()) generated = string(row.aiTitle).trim();
    if (row.type === "custom-title" && string(row.customTitle).trim()) custom = renamed = string(row.customTitle).trim();
    if (row.type === "system") {
      const content = string(row.content);
      const command = /<command-name>\s*\/?rename\s*<\/command-name>/.test(content);
      if (command) renamed = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1].trim() || "";
    }
  }
  return compatible ? custom || generated || sessionName || renamed || "" : renamed ?? generated;
}

export function parseClaude(text: string, path: string, options: { linear?: boolean; compatibleTitles?: boolean } = {}): HistorySession {
  const rows = jsonLines(text);
  const fileId = basename(path, ".jsonl");
  const isChild =
    fileId.startsWith("agent-") || basename(dirname(path)) === "subagents";
  const session: HistorySession = {
    id: isChild ? fileId : "",
    provider: "claude",
    cwd: "",
    metadata: { title: claudeSessionTitle(rows, options.compatibleTitles) },
    messages: [],
  };
  const ids = new Map<string, number>();
  const responseGroups = new Map<string, number>();
  const children = new Map<string, Set<string>>();
  for (const row of rows) {
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
