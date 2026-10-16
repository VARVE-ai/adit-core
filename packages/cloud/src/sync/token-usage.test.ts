import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, insertSession, insertEventAutoSeq, normalizeUsage, readTokenCaptureState, storeSessionUsage, type TokenUsageRecord } from "@varveai/adit-core";
import { acknowledgeEventTokenUsage, hasPendingTokenUsage, syncTokenUsage } from "./token-usage.js";
import { buildSyncBatch, type SyncBatch } from "./serializer.js";

describe("reply token usage sync", () => {
  let db: ReturnType<typeof openDatabase>;
  const scope = { projectId: "project", serverUrl: "https://cloud.example.com", cloudClientId: "client" };
  const record: TokenUsageRecord = { schemaVersion: 1, id: "a".repeat(64), sessionId: "session", turnId: "turn", revision: 1,
    provider: "codex", model: null, requestId: "request", responseId: "response", source: "transcript", granularity: "request",
    occurredAt: "2026-09-22T08:00:00.000Z", complete: true, ...normalizeUsage("codex", { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 }) };
  function save(value = record) {
    db.transaction(() => storeSessionUsage(db, "session", [value], readTokenCaptureState(db, "session")))();
  }
  const acknowledge = async (batch: SyncBatch) => ({ accepted: 0, duplicates: batch.events.length,
    eventTokenUsageAcknowledgements: batch.events.filter(event => event.tokenUsage).map(event => ({ id: event.id, revision: event.tokenUsage!.revision })),
  });
  beforeEach(() => {
    db = openDatabase(":memory:");
    insertSession(db, { id: "session", projectId: "project", clientId: "local-client", platform: "codex", sessionType: "interactive", startedAt: record.occurredAt, vclockJson: "{}" });
    insertEventAutoSeq(db, { id: "turn", sessionId: "session", eventType: "prompt_submit", actor: "user", startedAt: record.occurredAt, vclockJson: "{}" });
    insertEventAutoSeq(db, { id: "reply", sessionId: "session", parentEventId: "turn", eventType: "assistant_response", actor: "assistant", responseText: "Done", startedAt: record.occurredAt, vclockJson: "{}" });
    save();
  });
  afterEach(() => db.close());

  it("ships usage inside reply events, acknowledges the regular batch and never sends a ledger", async () => {
    const batch = buildSyncBatch(db, null, scope.projectId, scope.cloudClientId, 100).batch;
    expect(batch).not.toHaveProperty("tokenUsageRecords");
    expect(batch.events.find(event => event.id === "reply")?.tokenUsage).toMatchObject({ totalTokens: 15, revision: 1, records: [record] });
    acknowledgeEventTokenUsage(db, batch.events, await acknowledge(batch), scope);
    expect(hasPendingTokenUsage(db, scope)).toBe(false);
    const push = vi.fn(acknowledge);
    await syncTokenUsage(db, push, scope);
    expect(push).not.toHaveBeenCalled();
  });

  it("replays only the reply after late usage and scopes acknowledgement by server and client", async () => {
    const push = vi.fn(acknowledge);
    await syncTokenUsage(db, push, scope);
    expect(push.mock.calls[0][0].events.map(event => event.id)).toEqual(["reply"]);
    expect(hasPendingTokenUsage(db, { ...scope, serverUrl: scope.serverUrl + "/" })).toBe(false);
    expect(hasPendingTokenUsage(db, { ...scope, cloudClientId: "other" })).toBe(true);
    expect(hasPendingTokenUsage(db, { ...scope, serverUrl: "https://other.example.com" })).toBe(true);
    expect(hasPendingTokenUsage(db, { ...scope, projectId: "other" })).toBe(false);
    save({ ...record, revision: 2, ...normalizeUsage("codex", { input_tokens: 10, output_tokens: 8, cached_input_tokens: 0 }) });
    await syncTokenUsage(db, push, scope);
    expect(push.mock.calls[1][0].events[0].tokenUsage?.totalTokens).toBe(18);
    expect(db.prepare("SELECT count(*) AS count FROM events").get()).toEqual({ count: 2 });
  });

  it("keeps usage pending for failed, missing or incorrect acknowledgements", async () => {
    await expect(syncTokenUsage(db, async () => { throw new Error("offline"); }, scope)).rejects.toThrow("offline");
    for (const acknowledgements of [undefined, [], [{ id: "reply", revision: 2 }]]) {
      await expect(syncTokenUsage(db, async () => ({ accepted: 0, duplicates: 1, eventTokenUsageAcknowledgements: acknowledgements }), scope)).rejects.toThrow("acknowledge");
      expect(hasPendingTokenUsage(db, scope)).toBe(true);
    }
  });

  it("does not acknowledge newer usage captured during upload", async () => {
    const push = vi.fn(async (batch: SyncBatch) => {
      if (push.mock.calls.length === 1) save({ ...record, revision: 2, ...normalizeUsage("codex", { input_tokens: 10, output_tokens: 8, cached_input_tokens: 0 }) });
      return acknowledge(batch);
    });
    await syncTokenUsage(db, push, scope);
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[1][0].events[0].tokenUsage?.revision).toBe(2);
  });

  it("does not upload deleted replies or sessions", async () => {
    db.prepare("UPDATE events SET deleted_at='deleted' WHERE id='reply'").run();
    expect(hasPendingTokenUsage(db, scope)).toBe(false);
    db.prepare("UPDATE events SET deleted_at=NULL").run();
    db.prepare("UPDATE sessions SET deleted_at='deleted'").run();
    expect(hasPendingTokenUsage(db, scope)).toBe(false);
  });
});
