import { createReadStream } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

/** A missing SQLite index must not hide a resumable rollout. */
export async function hasCodexRolloutHistory(cwd: string, threadId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return false;
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const targetCwd = await normalizePath(cwd);
  for (const dir of ["sessions", "archived_sessions"]) {
    for await (const file of findRollouts(join(home, dir), threadId, 0)) {
      const input = createReadStream(file, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        let matchedMetadata = false;
        for await (const line of lines) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          if (!matchedMetadata) {
            if (record.type !== "session_meta" || record.payload?.id !== threadId ||
                typeof record.payload?.cwd !== "string" ||
                await normalizePath(record.payload.cwd) !== targetCwd) break;
            matchedMetadata = true;
            continue;
          }
          const payload = record.payload;
          if ((record.type === "response_item" && payload?.type === "message" && payload.role === "user") ||
              (record.type === "event_msg" && (payload?.type === "user_message" ||
                (payload?.type === "item_completed" && payload.item?.type === "UserMessage")))) {
            return true;
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
  }
  return false;
}

async function* findRollouts(dir: string, threadId: string, depth: number): AsyncGenerator<string> {
  if (depth > 5) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) yield* findRollouts(file, threadId, depth + 1);
    else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`)) {
      yield file;
    }
  }
}

async function normalizePath(value: string): Promise<string> {
  return realpath(resolve(value)).catch(() => resolve(value));
}
