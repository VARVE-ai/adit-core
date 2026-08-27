import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  closeDatabase,
  insertDiff,
  insertEnvSnapshot,
  insertEvent,
  insertSession,
  openDatabase,
} from "@varveai/adit-core";
import { buildSyncBatch, countUnsyncedEvents, countUnsyncedRecords } from "./serializer.js";

const PROJECT_ID = "proj-serializer";
const LOCAL_CLIENT_ID = "local-client";
const CLOUD_CLIENT_ID = "cloud-client";

function tempDbPath(): string {
  return join(tmpdir(), `adit-cloud-serializer-${randomBytes(8).toString("hex")}.sqlite`);
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = path + suffix;
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

function insertTestSession(db: Database.Database, id: string): void {
  insertSession(db, {
    id,
    projectId: PROJECT_ID,
    clientId: LOCAL_CLIENT_ID,
    sessionType: "interactive",
    platform: "claude-code",
    startedAt: "2026-05-18T00:00:00.000Z",
    vclockJson: "{}",
  });
}

function insertTestEvent(
  db: Database.Database,
  input: {
    id: string;
    sessionId: string;
    eventType: "checkpoint" | "prompt_submit" | "assistant_response";
    sequence: number;
    promptText?: string;
    responseText?: string;
    toolInputJson?: string;
    toolOutputJson?: string;
  },
): void {
  insertEvent(db, {
    id: input.id,
    sessionId: input.sessionId,
    sequence: input.sequence,
    eventType: input.eventType,
    actor: input.eventType === "prompt_submit" ? "user" : "assistant",
    promptText: input.promptText ?? null,
    responseText: input.responseText ?? null,
    toolInputJson: input.toolInputJson ?? null,
    toolOutputJson: input.toolOutputJson ?? null,
    startedAt: "2026-05-18T00:00:00.000Z",
    status: "success",
    vclockJson: "{}",
  });
}

describe("sync serializer", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  it("includes unanswered prompts without blocking later sessions", () => {
    const firstSessionId = "01H000000000000000000000001";
    const laterSessionId = "01H000000000000000000000025";
    insertTestSession(db, firstSessionId);
    insertTestSession(db, laterSessionId);

    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId: firstSessionId,
      eventType: "checkpoint",
      sequence: 1,
      responseText: "Session started",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000020",
      sessionId: firstSessionId,
      eventType: "prompt_submit",
      sequence: 2,
      promptText: "half turn",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000030",
      sessionId: laterSessionId,
      eventType: "checkpoint",
      sequence: 1,
      responseText: "Later session started",
    });

    const { batch } = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 500);

    expect(batch.sessions.map((s) => s.id)).toEqual([firstSessionId, laterSessionId]);
    expect(batch.events.map((e) => e.id)).toEqual([
      "01H000000000000000000000010",
      "01H000000000000000000000020",
      "01H000000000000000000000030",
    ]);
    expect(batch.events.some((e) => e.event_type === "prompt_submit")).toBe(true);
    expect(batch).not.toHaveProperty("plans");
    expect(batch.events[0]).not.toHaveProperty("plan_task_id");
  });

  it("includes a prompt once the same session has a following assistant response", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);

    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId,
      eventType: "checkpoint",
      sequence: 1,
      responseText: "Session started",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000020",
      sessionId,
      eventType: "prompt_submit",
      sequence: 2,
      promptText: "closed turn",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000030",
      sessionId,
      eventType: "assistant_response",
      sequence: 3,
      promptText: "closed turn",
      responseText: "done",
    });

    const { batch } = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 500);

    expect(batch.events.map((e) => e.id)).toEqual([
      "01H000000000000000000000010",
      "01H000000000000000000000020",
      "01H000000000000000000000030",
    ]);
  });

  it("compares session timestamps across SQLite and ISO timezone formats", () => {
    const olderSessionId = "01H000000000000000000000001";
    const newerSessionId = "01H000000000000000000000002";
    const cursor = "01H000000000000000000000099";
    const lastSyncedAt = "2026-07-13T08:30:00.000Z";
    insertTestSession(db, olderSessionId);
    insertTestSession(db, newerSessionId);

    db.prepare("UPDATE sessions SET ended_at = ?, status = 'completed' WHERE id = ?")
      .run("2026-07-13T16:00:00+08:00", olderSessionId);
    db.prepare("UPDATE sessions SET ended_at = ?, status = 'completed' WHERE id = ?")
      .run("2026-07-13T17:00:00+08:00", newerSessionId);
    const { batch } = buildSyncBatch(
      db,
      cursor,
      lastSyncedAt,
      PROJECT_ID,
      CLOUD_CLIENT_ID,
      500,
    );

    expect(batch.sessions.map((session) => session.id)).toEqual([newerSessionId]);
    expect(countUnsyncedRecords(db, cursor, lastSyncedAt, PROJECT_ID)).toBe(1);
    expect(countUnsyncedEvents(db, cursor, PROJECT_ID)).toBe(0);
  });

  it("counts only events toward the auto-sync threshold", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);
    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId,
      eventType: "prompt_submit",
      sequence: 1,
      promptText: "question",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000020",
      sessionId,
      eventType: "assistant_response",
      sequence: 2,
      promptText: "question",
      responseText: "answer",
    });

    expect(countUnsyncedEvents(db, null, PROJECT_ID)).toBe(2);
    expect(countUnsyncedEvents(db, "01H000000000000000000000010", PROJECT_ID)).toBe(1);
    // countUnsyncedRecords additionally counts the new session row
    expect(countUnsyncedRecords(db, null, null, PROJECT_ID)).toBe(3);
  });

  it("keeps environment snapshots local and excludes them from sync batches", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);
    insertEnvSnapshot(db, {
      id: "01H000000000000000000000010",
      sessionId,
      gitBranch: "develop",
      gitHeadSha: "abc123",
      envVarsJson: JSON.stringify({ HOME: "/Users/test", PATH: "/usr/bin" }),
      nodeVersion: "v22.0.0",
      pythonVersion: "Python 3.14.0",
      osInfo: "darwin 25.5.0",
      vclockJson: "{}",
    });

    const { batch } = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 500);
    const localSnapshotCount = db
      .prepare("SELECT COUNT(*) AS count FROM env_snapshots")
      .get() as { count: number };

    expect(localSnapshotCount.count).toBe(1);
    expect(batch.envSnapshots).toEqual([]);
    expect(JSON.stringify(batch)).not.toContain("/Users/test");
  });

  it("treats multiple prompts as closed once the session has a following assistant response", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);

    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId,
      eventType: "prompt_submit",
      sequence: 1,
      promptText: "first prompt",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000020",
      sessionId,
      eventType: "prompt_submit",
      sequence: 2,
      promptText: "second prompt",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000030",
      sessionId,
      eventType: "assistant_response",
      sequence: 3,
      promptText: "second prompt",
      responseText: "done",
    });

    const { batch } = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 500);

    expect(batch.events.map((e) => e.id)).toEqual([
      "01H000000000000000000000010",
      "01H000000000000000000000020",
      "01H000000000000000000000030",
    ]);
  });

  it("trims trailing events when their diffs exceed the byte cap so diffs are never orphaned", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);

    const bigDiff = "x".repeat(1_200_000); // two of these exceed the 2MB cap
    for (let i = 1; i <= 3; i++) {
      const eventId = `01H0000000000000000000000${i}0`;
      insertTestEvent(db, {
        id: eventId,
        sessionId,
        eventType: "assistant_response",
        sequence: i,
        responseText: `turn ${i}`,
      });
      insertDiff(db, {
        id: `01H0000000000000000000000${i}D`,
        eventId,
        diffText: bigDiff,
      });
    }

    const first = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 500);

    // Only the first event fits under the cap; it ships WITH its diff.
    expect(first.diffByteCapApplied).toBe(true);
    expect(first.batch.events.map((e) => e.id)).toEqual(["01H000000000000000000000010"]);
    expect(first.batch.diffs.map((d) => d.event_id)).toEqual(["01H000000000000000000000010"]);

    // The trimmed events are picked up by the next batch (cursor = last shipped event).
    const second = buildSyncBatch(
      db,
      "01H000000000000000000000010",
      null,
      PROJECT_ID,
      CLOUD_CLIENT_ID,
      500,
    );
    expect(second.batch.events.map((e) => e.id)).toEqual(["01H000000000000000000000020"]);
    expect(second.batch.diffs.map((d) => d.event_id)).toEqual(["01H000000000000000000000020"]);
  });

  it("ships diffs even when the record-count budget is exhausted", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);

    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId,
      eventType: "assistant_response",
      sequence: 1,
      responseText: "turn 1",
    });
    insertDiff(db, {
      id: "01H00000000000000000000001D",
      eventId: "01H000000000000000000000010",
      diffText: "small diff",
    });

    // batchSize 2: the session + event consume the whole record budget,
    // leaving remaining=0 at the diff step. Diffs are exempt from the
    // count budget — dropping them here would orphan them forever.
    const { batch } = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 2);

    expect(batch.events.map((e) => e.id)).toEqual(["01H000000000000000000000010"]);
    expect(batch.diffs.map((d) => d.event_id)).toEqual(["01H000000000000000000000010"]);
  });

  it("truncates a single oversized diff instead of stalling on it", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);

    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId,
      eventType: "assistant_response",
      sequence: 1,
      responseText: "huge turn",
    });
    insertDiff(db, {
      id: "01H00000000000000000000001D",
      eventId: "01H000000000000000000000010",
      diffText: "y".repeat(3_000_000), // exceeds the 2MB cap on its own
    });

    const { batch, diffByteCapApplied } = buildSyncBatch(
      db,
      null,
      null,
      PROJECT_ID,
      CLOUD_CLIENT_ID,
      500,
    );

    // The event still ships, with its diff truncated to fit the cap.
    expect(diffByteCapApplied).toBe(false);
    expect(batch.events.map((e) => e.id)).toEqual(["01H000000000000000000000010"]);
    expect(batch.diffs).toHaveLength(1);
    expect(batch.diffs[0].diff_text.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(batch.diffs[0].diff_text.endsWith("[truncated by adit sync: diff exceeds batch byte cap]")).toBe(true);
  });

  it("does not modify event text fields while building sync batches", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);
    const prompt = "p".repeat(140_000);

    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId,
      eventType: "prompt_submit",
      sequence: 1,
      promptText: prompt,
      responseText: "small response",
      toolInputJson: JSON.stringify({ command: "git status" }),
    });

    const { batch } = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 500);
    const event = batch.events[0];

    expect(event.prompt_text).toBe(prompt);
    expect(event.response_text).toBe("small response");
    expect(event.tool_input_json).toBe(JSON.stringify({ command: "git status" }));
  });
});
