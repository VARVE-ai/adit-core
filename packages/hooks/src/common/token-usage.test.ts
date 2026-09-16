import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, insertSession, insertEventAutoSeq, type TokenUsageRecord } from "@varveai/adit-core";
import { captureTokenUsage } from "./token-usage.js";
import type { HookContext } from "./context.js";

describe("incremental token usage ledger", () => {
  let directory: string;
  let transcript: string;
  let ctx: HookContext;
  const raw = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "adit-usage-"));
    transcript = join(directory, "session.jsonl");
    writeFileSync(transcript, "");
    const db = openDatabase(join(directory, "adit.sqlite"));
    insertSession(db, { id: "session", projectId: "project", clientId: "client", sessionType: "interactive", platform: "claude-code", startedAt: new Date().toISOString(), vclockJson: "{}" });
    ctx = { db, session: { id: "session", platform: "claude-code" } } as HookContext;
    for (const turnId of ["turn-1", "turn-2"]) {
      insertEventAutoSeq(db, { id: turnId, sessionId: "session", eventType: "prompt_submit", actor: "user", startedAt: new Date().toISOString(), vclockJson: "{}" });
    }
  });
  afterEach(() => { ctx.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const records = () => (ctx.db.prepare("SELECT record_json FROM token_usage_records ORDER BY rowid").all() as { record_json: string }[]).map((row) => JSON.parse(row.record_json) as TokenUsageRecord);
  function append(responseId: string, usage = raw) {
    appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { id: responseId, model: "test-model", content: "secret code", usage } }) + "\n");
  }

  it("starts at EOF, preserves new identities with equal counts and deduplicates replay", () => {
    append("history");
    captureTokenUsage(ctx, transcript, "prompt", "turn-1");
    append("response-a"); append("response-b"); append("response-a");
    captureTokenUsage(ctx, transcript, "stop");
    captureTokenUsage(ctx, transcript, "stop");
    expect(records()).toHaveLength(2);
    expect(records().map((record) => record.responseId)).toEqual(["response-a", "response-b"]);
    expect(records().every((record) => record.turnId === "turn-1" && record.totalTokens === 13)).toBe(true);
    const events = ctx.db.prepare("SELECT tool_input_json FROM events WHERE event_type='token_usage'").all();
    expect(events).toHaveLength(0);
    expect(JSON.stringify(records())).not.toContain("secret code");
  });

  it("updates only the ledger revision without emitting conversation events", () => {
    captureTokenUsage(ctx, transcript, "prompt", "turn-1");
    append("response-a", { ...raw, output_tokens: 1 });
    captureTokenUsage(ctx, transcript, "stop");
    append("response-a");
    captureTokenUsage(ctx, transcript, "stop");
    expect(records()).toHaveLength(1);
    expect(records()[0].revision).toBe(2);
    expect(records()[0].outputTokens).toBe(3);
    expect(ctx.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='token_usage'").get()).toEqual({ count: 0 });
  });

  it("does not consume a partial JSON line and records an explicit gap", () => {
    captureTokenUsage(ctx, transcript, "prompt", "turn-1");
    const entry = JSON.stringify({ type: "assistant", message: { id: "response-a", usage: raw } });
    appendFileSync(transcript, entry.slice(0, 20));
    captureTokenUsage(ctx, transcript, "stop");
    expect(records()[0].granularity).toBe("gap");
    appendFileSync(transcript, entry.slice(20) + "\n");
    captureTokenUsage(ctx, transcript, "stop");
    expect(records().find((record) => record.responseId === "response-a")?.totalTokens).toBe(13);
  });

  it("does not import a transcript when the first boundary is Stop", () => {
    append("old-response");
    captureTokenUsage(ctx, transcript, "stop");
    expect(records()).toEqual([]);
  });

  it("can start before the platform creates its first transcript", () => {
    const newTranscript = join(directory, "new-session.jsonl");
    captureTokenUsage(ctx, newTranscript, "prompt", "turn-1");
    writeFileSync(newTranscript, JSON.stringify({ type: "assistant", message: { id: "first-response", usage: raw } }) + "\n");
    captureTokenUsage(ctx, newTranscript, "stop");
    expect(records()[0].responseId).toBe("first-response");
  });

  it("does not erase known usage when a later duplicate omits fields", () => {
    captureTokenUsage(ctx, transcript, "prompt", "turn-1");
    append("response-a");
    captureTokenUsage(ctx, transcript, "stop");
    appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { id: "response-a" } }) + "\n");
    captureTokenUsage(ctx, transcript, "stop");
    expect(records()).toHaveLength(1);
    expect(records()[0].totalTokens).toBe(13);
    expect(records()[0].revision).toBe(1);
  });

  it("recovers late data before switching to the next user turn", () => {
    captureTokenUsage(ctx, transcript, "prompt", "turn-1");
    append("late-response");
    captureTokenUsage(ctx, transcript, "prompt", "turn-2");
    append("next-response");
    captureTokenUsage(ctx, transcript, "stop");
    expect(records().map((record) => record.turnId)).toEqual(["turn-1", "turn-2"]);
  });

  it("keeps Codex snapshots separate from response-identified request usage", () => {
    ctx.session.platform = "codex";
    captureTokenUsage(ctx, transcript, "prompt", "turn-1");
    const usage = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80, reasoning_output_tokens: 15 };
    const snapshot = { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } };
    appendFileSync(transcript, [
      { type: "turn_context", payload: { model: "codex-test" } }, snapshot, snapshot,
      { type: "token_usage_record", payload: { response_id: "resp-1", usage } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    captureTokenUsage(ctx, transcript, "stop");
    expect(records()).toHaveLength(2);
    expect(records()[0].granularity).toBe("observation");
    expect(records()[0].complete).toBe(false);
    expect(records()[1].responseId).toBe("resp-1");
    expect(records()[1].totalTokens).toBe(120);
    expect(records()[1].complete).toBe(true);
  });

  it("cleans up the ledger and cursors when a session is deleted", () => {
    captureTokenUsage(ctx, transcript, "prompt", "turn-1"); append("response-a");
    captureTokenUsage(ctx, transcript, "stop");
    ctx.db.prepare("DELETE FROM events").run();
    ctx.db.prepare("DELETE FROM sessions WHERE id='session'").run();
    expect(records()).toEqual([]);
    expect(ctx.db.prepare("SELECT COUNT(*) AS count FROM token_usage_cursors").get()).toEqual({ count: 0 });
  });
});
