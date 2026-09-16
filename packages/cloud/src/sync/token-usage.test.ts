import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, insertSession, type TokenUsageRecord } from "@varveai/adit-core";
import { hasPendingTokenUsage, syncTokenUsage } from "./token-usage.js";
import type { SyncBatch } from "./serializer.js";

describe("token usage sync batches", () => {
  let db: ReturnType<typeof openDatabase>;
  const scope = { projectId: "project", serverUrl: "https://cloud.example.com", cloudClientId: "client" };
  const record = { id: "usage", sessionId: "session", turnId: "turn", revision: 1 } as TokenUsageRecord;
  function save(value = record) {
    db.prepare(`INSERT INTO token_usage_records VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, record_json = excluded.record_json`)
      .run(value.id, value.sessionId, value.turnId, value.revision, JSON.stringify(value));
  }
  const acknowledge = async (batch: SyncBatch) => ({
    accepted: batch.tokenUsageRecords!.length, duplicates: 0,
    tokenUsageAcknowledgements: batch.tokenUsageRecords!.map(({ id, revision }) => ({ id, revision })),
  });
  beforeEach(() => {
    db = openDatabase(":memory:");
    insertSession(db, { id: "session", projectId: "project", clientId: "local-client", platform: "codex", sessionType: "interactive", startedAt: new Date().toISOString(), vclockJson: "{}" });
    save();
  });
  afterEach(() => db.close());

  it("sends ledger records with their sessions, no events, and retries only revisions", async () => {
    const push = vi.fn(acknowledge);
    expect(hasPendingTokenUsage(db, scope)).toBe(true);
    const result = await syncTokenUsage(db, push, scope);
    expect(result.totalRecords).toBe(2);
    expect(push).toHaveBeenCalledOnce();
    expect(push.mock.calls[0][0]).toMatchObject({ events: [], tokenUsageRecords: [record], sessions: [{ id: "session", client_id: "client" }] });
    expect(hasPendingTokenUsage(db, { ...scope, serverUrl: scope.serverUrl + "/" })).toBe(false);
    await syncTokenUsage(db, push, scope);
    expect(push).toHaveBeenCalledOnce();
    save({ ...record, revision: 2 });
    await syncTokenUsage(db, push, scope);
    expect(push).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT * FROM events").all()).toEqual([]);
    expect(db.prepare("SELECT revision FROM token_usage_sync_state").get()).toEqual({ revision: 2 });
  });

  it("retains pending data after transport failures or missing/wrong acknowledgements", async () => {
    await expect(syncTokenUsage(db, async () => { throw new Error("offline"); }, scope)).rejects.toThrow("offline");
    for (const acknowledgements of [undefined, [], [{ id: "usage", revision: 2 }]]) {
      await expect(syncTokenUsage(db, async () => ({ accepted: 1, duplicates: 0, tokenUsageAcknowledgements: acknowledgements }), scope)).rejects.toThrow("acknowledge");
      expect(hasPendingTokenUsage(db, scope)).toBe(true);
    }
    await syncTokenUsage(db, acknowledge, scope);
    expect(hasPendingTokenUsage(db, scope)).toBe(false);
  });

  it("does not acknowledge a newer revision captured during upload", async () => {
    const push = vi.fn(async (batch: SyncBatch) => {
      if (push.mock.calls.length === 1) save({ ...record, revision: 2 });
      return acknowledge(batch);
    });
    await syncTokenUsage(db, push, scope);
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[1][0].tokenUsageRecords![0].revision).toBe(2);
  });

  it("scopes acknowledgements by server and client and excludes other projects/deleted sessions", async () => {
    await syncTokenUsage(db, acknowledge, scope);
    expect(hasPendingTokenUsage(db, { ...scope, cloudClientId: "other-client" })).toBe(true);
    expect(hasPendingTokenUsage(db, { ...scope, serverUrl: "https://other.example.com" })).toBe(true);
    expect(hasPendingTokenUsage(db, { ...scope, projectId: "other-project" })).toBe(false);
    db.prepare("UPDATE sessions SET deleted_at = 'deleted'").run();
    expect(hasPendingTokenUsage(db, { ...scope, cloudClientId: "other-client" })).toBe(false);
  });

  it("bounds batches and removes acknowledgement metadata on session deletion", async () => {
    for (let index = 0; index < 205; index++) save({ ...record, id: `usage-${index}` });
    const push = vi.fn(acknowledge);
    await syncTokenUsage(db, push, scope);
    expect(push.mock.calls.map(([batch]) => batch.tokenUsageRecords!.length)).toEqual([100, 100, 6]);
    db.prepare("DELETE FROM sessions").run();
    expect(db.prepare("SELECT * FROM token_usage_records").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM token_usage_sync_state").all()).toEqual([]);
  });
});
