import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasCodexRolloutHistory } from "./local-rollout.js";

const id = "01a07b13-36dd-70a1-b7af-6b0ae121d997";
let home: string;
let cwd: string;
let file: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "adit-rollout-"));
  cwd = join(home, "project");
  mkdirSync(cwd);
  const dir = join(home, "sessions", "2026", "09", "07");
  mkdirSync(dir, { recursive: true });
  file = join(dir, `rollout-2026-09-07T16-54-11-${id}.jsonl`);
  vi.stubEnv("CODEX_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function writeRollout(threadId = id, project = cwd, history = true) {
  const records: unknown[] = [{ type: "session_meta", payload: { id: threadId, cwd: project } }];
  if (history) records.push({ type: "event_msg", payload: {
    type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "test" }] },
  } });
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

describe("hasCodexRolloutHistory", () => {
  it("finds history without any SQLite database", async () => {
    writeRollout();
    await expect(hasCodexRolloutHistory(cwd, id)).resolves.toBe(true);
  });

  it("rejects another thread or project even when the filename matches", async () => {
    writeRollout("01a07b13-80d4-72c0-92e0-f543587c10db");
    await expect(hasCodexRolloutHistory(cwd, id)).resolves.toBe(false);
    writeRollout(id, home);
    await expect(hasCodexRolloutHistory(cwd, id)).resolves.toBe(false);
  });

  it("does not treat missing or metadata-only rollouts as message history", async () => {
    await expect(hasCodexRolloutHistory(cwd, id)).resolves.toBe(false);
    writeRollout(id, cwd, false);
    await expect(hasCodexRolloutHistory(cwd, id)).resolves.toBe(false);
  });

  it("reports unreadable history instead of treating it as empty", async () => {
    writeFileSync(file, "{broken\n");
    await expect(hasCodexRolloutHistory(cwd, id)).rejects.toThrow();
  });
});
