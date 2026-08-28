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
  getSessionByPlatformSessionId,
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
