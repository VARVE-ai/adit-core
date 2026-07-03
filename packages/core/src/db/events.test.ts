import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "./connection.js";
import { insertSession } from "./sessions.js";
import {
  insertEvent,
  getEventById,
  queryEvents,
  getEventsBySession,
  updateEventStatus,
  updateEventLabels,
  searchEvents,
} from "./events.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-test-${randomBytes(8).toString("hex")}.sqlite`);
}

describe("Events CRUD", () => {
  let db: Database.Database;
  let dbPath: string;
  const sessionId = "test-session-001";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);

    // Create a test session
    insertSession(db, {
      id: sessionId,
      projectId: "test-project",
      clientId: "test-client",
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });
  });

  afterEach(() => {
    closeDatabase(db);
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
      if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
    } catch {
      // Best effort
    }
  });

  it("inserts and retrieves an event", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      promptText: "Hello, Claude!",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    const event = getEventById(db, "evt-001");
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe("prompt_submit");
    expect(event!.actor).toBe("user");
    expect(event!.promptText).toBe("Hello, Claude!");
  });

  it("queries events by type and actor", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });
    insertEvent(db, {
      id: "evt-002",
      sessionId,
      sequence: 2,
      eventType: "tool_call",
      actor: "tool",
      toolName: "Read",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 2}',
    });

    const userEvents = queryEvents(db, { actor: "user" });
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].actor).toBe("user");

    const toolEvents = queryEvents(db, { eventType: "tool_call" });
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].toolName).toBe("Read");
  });

  it("updates event status", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "tool_call",
      actor: "tool",
      startedAt: new Date().toISOString(),
      status: "running",
      vclockJson: '{"test-client": 1}',
    });

    updateEventStatus(db, "evt-001", "success");
    const event = getEventById(db, "evt-001");
    expect(event!.status).toBe("success");
    expect(event!.endedAt).not.toBeNull();
  });

  it("updates labels", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "assistant_response",
      actor: "assistant",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    updateEventLabels(
      db,
      "evt-001",
      '["working-auth", "pre-refactor"]',
      '{"test-client": 2}',
    );

    const event = getEventById(db, "evt-001");
    expect(JSON.parse(event!.labelsJson!)).toEqual([
      "working-auth",
      "pre-refactor",
    ]);
  });

  it("searches events by prompt text", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      promptText: "Add authentication to the login page",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });
    insertEvent(db, {
      id: "evt-002",
      sessionId,
      sequence: 2,
      eventType: "prompt_submit",
      actor: "user",
      promptText: "Fix the CSS styling on the header",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 2}',
    });

    const results = searchEvents(db, "authentication");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("evt-001");
  });

  it("queries events filtered by git branch", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "assistant_response",
      actor: "assistant",
      gitBranch: "main",
      checkpointSha: "aaa111",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });
    insertEvent(db, {
      id: "evt-002",
      sessionId,
      sequence: 2,
      eventType: "assistant_response",
      actor: "assistant",
      gitBranch: "feature/auth",
      checkpointSha: "bbb222",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 2}',
    });
    insertEvent(db, {
      id: "evt-003",
      sessionId,
      sequence: 3,
      eventType: "prompt_submit",
      actor: "user",
      gitBranch: "main",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 3}',
    });

    const mainEvents = queryEvents(db, { gitBranch: "main" });
    expect(mainEvents).toHaveLength(2);
    expect(mainEvents.every((e) => e.gitBranch === "main")).toBe(true);

    const featureEvents = queryEvents(db, { gitBranch: "feature/auth" });
    expect(featureEvents).toHaveLength(1);
    expect(featureEvents[0].id).toBe("evt-002");

    // Combined filter: branch + checkpoint
    const mainCheckpoints = queryEvents(db, { gitBranch: "main", hasCheckpoint: true });
    expect(mainCheckpoints).toHaveLength(1);
    expect(mainCheckpoints[0].id).toBe("evt-001");
  });

  it("gets events by session ordered by sequence", () => {
    for (let i = 1; i <= 5; i++) {
      insertEvent(db, {
        id: `evt-${String(i).padStart(3, "0")}`,
        sessionId,
        sequence: i,
        eventType: "tool_call",
        actor: "tool",
        toolName: `Tool${i}`,
        startedAt: new Date().toISOString(),
        vclockJson: `{"test-client": ${i}}`,
      });
    }

    const events = getEventsBySession(db, sessionId);
    expect(events).toHaveLength(5);
    expect(events[0].sequence).toBe(1);
    expect(events[4].sequence).toBe(5);
  });
});
