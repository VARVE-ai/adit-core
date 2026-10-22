import { basename, dirname, extname, relative, sep, join } from "node:path";
import {
  databaseSnapshot,
  directoryEntries,
  hasTable,
  timestamp,
} from "./source-io.js";
import {
  HistoryFormatError,
  jsonDocument,
  jsonLines,
  record,
  string,
  type HistoryMessage,
  type HistorySession,
} from "./types.js";
import { insideDirectory } from "./sources.js";
import { cursorUserQuery } from "./cursor-prompt.js";
import { textContent } from "./prompt-summary.js";

export async function cursorWorkspace(
  root: string,
  path: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  const normalize = (value: string) => {
    const tokens = value
      .split(/[:\\/._-]+/)
      .filter(Boolean)
      .join("-");
    return process.platform === "win32" ? tokens.toLowerCase() : tokens;
  };
  const project = normalize(relative(root, path).split(sep)[0]);
  const matches: string[] = [];
  const visit = async (cwd: string, depth: number) => {
    signal?.throwIfAborted();
    if (depth > 10 || matches.length > 1) return;
    const key = normalize(cwd);
    if (key === project) {
      matches.push(cwd);
      return;
    }
    if (!project.startsWith(key + "-")) return;
    for (const entry of await directoryEntries(cwd)) {
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !["node_modules", ".git"].includes(entry.name)
      )
        await visit(join(cwd, entry.name), depth + 1);
    }
  };
  await visit(workspace, 0);
  return matches.length === 1 ? matches[0] : "";
}

export function parseCursor(
  text: string,
  path: string,
  cwd: string,
): HistorySession {
  if (!cwd)
    throw new HistoryFormatError(
      "Cursor project path cannot be resolved unambiguously",
    );
  const messages: HistoryMessage[] = [];
  if (text.trimStart().startsWith("{")) {
    for (const row of jsonLines(text)) {
      if (row.role !== "user" && row.role !== "assistant") continue;
      const m = record(row.message);
      if (m.content === undefined) continue;
      messages.push({
        key: string(row.id) || String(messages.length),
        role: row.role,
        content: m.content,
        model: string(m.model) || undefined,
        timestamp: timestamp(row.timestamp) ?? (row.role === "user" ? cursorUserQuery(textContent(m.content))?.timestamp : undefined),
        raw: row,
      });
    }
  } else {
    let role = "";
    let body: string[] = [];
    const flush = () => {
      if (role && body.join("\n").trim())
        messages.push({
          key: String(messages.length),
          role,
          content: body.join("\n").trim(),
          timestamp: role === "user" ? cursorUserQuery(body.join("\n"))?.timestamp : undefined,
          raw: { role, text: body.join("\n") },
        });
    };
    for (const line of text.split(/\r?\n/)) {
      if (/^(user|assistant):\s*$/.test(line)) {
        flush();
        role = line.trim().slice(0, -1);
        body = [];
      } else body.push(line);
    }
    flush();
  }
  return {
    id: basename(path, extname(path)),
    provider: "cursor",
    cwd,
    messages,
    parentId:
      basename(dirname(path)) === "subagents"
        ? basename(dirname(dirname(path)))
        : undefined,
  };
}

export function readCursorIDE(
  path: string,
  workspace: string | string[],
  signal?: AbortSignal,
  onMemberError?: (id:string,error:unknown)=>void,
): HistorySession[] {
  return databaseSnapshot(path, (db) => {
    if (!hasTable(db, "cursorDiskKV")) return [];
    const composers = db
      .prepare(
        "SELECT key,value FROM cursorDiskKV WHERE key>=? AND key<? ORDER BY key",
      )
      .all("composerData:", "composerData;") as {
      key: string;
      value: string | Buffer | null;
    }[];
    const get = db.prepare("SELECT value FROM cursorDiskKV WHERE key=?");
    const sessions: HistorySession[] = [];
    for (const row of composers) {
      signal?.throwIfAborted();
      if (!row.value?.length) continue;
      const id = row.key.slice("composerData:".length);
      try {
      const data = jsonDocument(row.value.toString());
      const repos = Array.isArray(data.trackedGitRepos)
        ? data.trackedGitRepos
        : [];
      const cwd =
        string(record(record(data.workspaceIdentifier).uri).fsPath) ||
        string(record(repos[0]).repoPath);
      if (!cwd || !(Array.isArray(workspace) ? workspace : [workspace]).some(scope => insideDirectory(scope, cwd))) continue;
      if (!Array.isArray(data.fullConversationHeadersOnly)) continue;
      const messages: HistoryMessage[] = [];
      for (const value of data.fullConversationHeadersOnly) {
        signal?.throwIfAborted();
        const header = record(value);
        const key = string(header.bubbleId);
        if (!key)
          throw new HistoryFormatError("Cursor IDE bubble identity is missing");
        const bubble = get.get(`bubbleId:${id}:${key}`) as
          | { value: string | Buffer | null }
          | undefined;
        if (!bubble?.value?.length)
          throw new HistoryFormatError(
            "Cursor IDE transcript has missing bubbles; previous archive retained",
          );
        const b = jsonDocument(bubble.value.toString());
        const role =
          (b.type || header.type) === 1
            ? "user"
            : (b.type || header.type) === 2
              ? "assistant"
              : "";
        if (!role) continue;
        const tool = record(b.toolFormerData);
        if (!string(b.text) && !Object.keys(tool).length)
          throw new HistoryFormatError(
            "Cursor IDE transcript contains an unfinished bubble; retry on the next collection",
          );
        // Composer documents contain encryption keys. Persist only transcript fields, never the document.
        const raw = {
          text: b.text,
          createdAt: b.createdAt,
          toolFormerData: Object.keys(tool).length
            ? {
                toolCallId: tool.toolCallId,
                name: tool.name,
                rawArgs: tool.rawArgs,
                result: tool.result,
              }
            : undefined,
        };
        messages.push({
          key,
          role,
          content: tool.name ? raw : b.text,
          timestamp: timestamp(b.createdAt),
          raw,
        });
      }
      if (messages.length)
        sessions.push({ id, provider: "cursor-ide", cwd, messages, metadata: { title: string(data.name).trim() } });
      }catch(error){signal?.throwIfAborted();if(!onMemberError)throw error;onMemberError(id,error);}
    }
    return sessions;
  });
}
