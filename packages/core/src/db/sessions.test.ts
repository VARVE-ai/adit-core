import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "./connection.js";
import {
  insertSession,
  getActiveSession,
  getSessionById,
  getSessionByPlatformSessionId,
  reviveSession,
  endSession,
  endStaleSessions,
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

describe("getActiveSession platform filter", () => {
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

  it("returns the latest active session regardless of platform when unfiltered", () => {
    expect(getActiveSession(db, PROJECT, CLIENT)?.id).toBe("codex-session");
  });

  it("scopes the lookup to the requested platform", () => {
    expect(getActiveSession(db, PROJECT, CLIENT, "claude-code")?.id).toBe("claude-session");
    expect(getActiveSession(db, PROJECT, CLIENT, "codex")?.id).toBe("codex-session");
    expect(getActiveSession(db, PROJECT, CLIENT, "gemini")).toBeNull();
  });
});

describe("endStaleSessions", () => {
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

  function addSession(id: string, platform: "codex" | "claude-code", startedAt: string): void {
    insertSession(db, {
      id,
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive",
      platform,
      startedAt,
      vclockJson: "{}",
    });
  }

  function addEvent(sessionId: string, startedAt: string): void {
    insertEvent(db, {
      id: `evt-${sessionId}-${randomBytes(4).toString("hex")}`,
      sessionId,
      sequence: Math.floor(Math.random() * 100000),
      eventType: "prompt_submit",
      actor: "user",
      startedAt,
      vclockJson: "{}",
    });
  }

  it("closes sessions with no events past the cutoff", () => {
    addSession("old-idle", "codex", isoHoursAgo(48));

    const closed = endStaleSessions(db, {
      projectId: PROJECT,
      platform: "codex",
      cutoffIso: isoHoursAgo(24),
    });

    expect(closed).toBe(1);
    const session = getSessionById(db, "old-idle");
    expect(session?.status).toBe("completed");
    expect(session?.endedAt).toBeTruthy();
  });

  it("keeps long-running sessions that still have recent events", () => {
    // Started 3 days ago but had an event 1 hour ago — must survive.
    addSession("long-running", "codex", isoHoursAgo(72));
    addEvent("long-running", isoHoursAgo(1));

    const closed = endStaleSessions(db, {
      projectId: PROJECT,
      platform: "codex",
      cutoffIso: isoHoursAgo(24),
    });

    expect(closed).toBe(0);
    expect(getSessionById(db, "long-running")?.status).toBe("active");
  });

  it("closes sessions whose newest event is older than the cutoff", () => {
    addSession("went-quiet", "codex", isoHoursAgo(72));
    addEvent("went-quiet", isoHoursAgo(48));

    const closed = endStaleSessions(db, {
      projectId: PROJECT,
      platform: "codex",
      cutoffIso: isoHoursAgo(24),
    });

    expect(closed).toBe(1);
    expect(getSessionById(db, "went-quiet")?.status).toBe("completed");
  });

  it("only touches the requested platform and skips the excluded session", () => {
    addSession("stale-codex", "codex", isoHoursAgo(48));
    addSession("stale-claude", "claude-code", isoHoursAgo(48));
    addSession("current-codex", "codex", isoHoursAgo(48));

    const closed = endStaleSessions(db, {
      projectId: PROJECT,
      platform: "codex",
      cutoffIso: isoHoursAgo(24),
      excludeSessionId: "current-codex",
    });

    expect(closed).toBe(1);
    expect(getSessionById(db, "stale-codex")?.status).toBe("completed");
    expect(getSessionById(db, "stale-claude")?.status).toBe("active");
    expect(getSessionById(db, "current-codex")?.status).toBe("active");
  });
});


describe("getSessionByPlatformSessionId resume reuse", () => {
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

  it("returns a closed session for the same platform session id instead of null", () => {
    endSession(db, "ulid-1", "completed");

    const found = getSessionByPlatformSessionId(db, "platform-abc");
    expect(found?.id).toBe("ulid-1");
    expect(found?.status).toBe("completed");
  });

  it("prefers a still-active row over a newer closed row", () => {
    endSession(db, "ulid-1", "completed");
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
    expect(found?.status).toBe("active");
  });

  it("reviveSession reopens a closed session and clears ended_at", () => {
    endSession(db, "ulid-1", "completed");
    reviveSession(db, "ulid-1");

    const revived = getSessionById(db, "ulid-1");
    expect(revived?.status).toBe("active");
    expect(revived?.endedAt).toBeNull();
  });
});
