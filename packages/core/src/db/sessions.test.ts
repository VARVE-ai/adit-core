import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "./connection.js";
import {
  insertSession,
  getLatestSession,
  getSessionById,
  getSessionByPlatformSessionId,
  mergeSessionMetadata,
} from "./sessions.js";
import { insertEvent } from "./events.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-test-${randomBytes(8).toString("hex")}.sqlite`);
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

const PROJECT = "test-project";
const CLIENT = "test-client";

describe("getLatestSession", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);

    insertSession(db, {
      id: "claude-session",
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: isoHoursAgo(2),
      vclockJson: "{}",
    });
    insertSession(db, {
      id: "codex-session",
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive",
      platform: "codex",
      startedAt: isoHoursAgo(1),
      vclockJson: "{}",
    });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("falls back to startedAt when sessions have no events", () => {
    expect(getLatestSession(db, PROJECT, CLIENT)?.id).toBe("codex-session");
  });

  it("scopes the lookup to the requested platform", () => {
    expect(getLatestSession(db, PROJECT, CLIENT, "claude-code")?.id).toBe("claude-session");
    expect(getLatestSession(db, PROJECT, CLIENT, "codex")?.id).toBe("codex-session");
    expect(getLatestSession(db, PROJECT, CLIENT, "gemini")).toBeNull();
  });

  it("uses the latest Event as the session activity time", () => {
    insertEvent(db, {
      id: "event-claude-latest",
      sessionId: "claude-session",
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      startedAt: new Date().toISOString(),
      vclockJson: "{}",
    });

    expect(getLatestSession(db, PROJECT, CLIENT)?.id).toBe("claude-session");
  });
});

describe("getSessionByPlatformSessionId", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);
    insertSession(db, {
      id: "ulid-1",
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: isoHoursAgo(3),
      vclockJson: "{}",
      platformSessionId: "platform-abc",
    });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("returns the row for the exact platform session id", () => {
    const found = getSessionByPlatformSessionId(db, "platform-abc");
    expect(found?.id).toBe("ulid-1");
  });

  it("prefers the newest historical duplicate without inferring lifecycle state", () => {
    insertSession(db, {
      id: "ulid-2",
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: isoHoursAgo(1),
      vclockJson: "{}",
      platformSessionId: "platform-abc",
    });

    const found = getSessionByPlatformSessionId(db, "platform-abc");
    expect(found?.id).toBe("ulid-2");
  });
});

describe("mergeSessionMetadata", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  function addSession(id: string, metadataJson?: string | null): void {
    insertSession(db, {
      id,
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: isoHoursAgo(1),
      vclockJson: "{}",
      metadataJson: metadataJson ?? null,
    });
  }

  function readMetadata(id: string): Record<string, unknown> {
    return JSON.parse(getSessionById(db, id)?.metadataJson ?? "{}");
  }

  it("merges new keys while preserving existing metadata", () => {
    addSession("s1", JSON.stringify({ gitBranch: "main", workingDirectory: "/repo" }));

    mergeSessionMetadata(db, "s1", { model: "claude-fable-5", source: "startup" });

    expect(readMetadata("s1")).toEqual({
      gitBranch: "main",
      workingDirectory: "/repo",
      model: "claude-fable-5",
      source: "startup",
    });
  });

  it("overwrites values for keys present in the patch", () => {
    addSession("s2", JSON.stringify({ model: "old-model", gitBranch: "main" }));

    mergeSessionMetadata(db, "s2", { model: "new-model" });

    expect(readMetadata("s2")).toEqual({ model: "new-model", gitBranch: "main" });
  });

  it("writes a fresh object when metadata is null or corrupt", () => {
    addSession("s3", null);
    mergeSessionMetadata(db, "s3", { model: "m1" });
    expect(readMetadata("s3")).toEqual({ model: "m1" });

    addSession("s4", "{not-json");
    mergeSessionMetadata(db, "s4", { model: "m2" });
    expect(readMetadata("s4")).toEqual({ model: "m2" });
  });

  it("is a no-op for an unknown session id", () => {
    expect(() => mergeSessionMetadata(db, "missing", { model: "x" })).not.toThrow();
  });
});
