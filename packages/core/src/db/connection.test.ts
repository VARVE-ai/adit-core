import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "./connection.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-test-${randomBytes(8).toString("hex")}.sqlite`);
}

describe("Database", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) {
      try {
        if (existsSync(p)) unlinkSync(p);
        if (existsSync(p + "-wal")) unlinkSync(p + "-wal");
        if (existsSync(p + "-shm")) unlinkSync(p + "-shm");
      } catch {
        // Best effort
      }
    }
    paths.length = 0;
  });

  it("creates a new database with all tables", () => {
    const path = tempDbPath();
    paths.push(path);
    const db = openDatabase(path);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain("sessions");
    expect(tables).toContain("events");
    expect(tables).toContain("env_snapshots");
    expect(tables).not.toContain("plans");
    expect(tables).not.toContain("transcript_uploads");
    expect(tables).toContain("diffs");
    expect(tables).toContain("_migrations");

    const eventColumns = db
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(eventColumns).not.toContain("plan_task_id");

    const sessionColumns = db
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(sessionColumns).not.toContain("ended_at");
    expect(sessionColumns).not.toContain("status");

    const projectLinkColumns = db
      .prepare("PRAGMA table_info(project_link_cache)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(projectLinkColumns).toContain("git_ref_heads_json");
    expect(projectLinkColumns).toContain("git_refs_fingerprint");

    const eventIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(eventIndexes).toContain("idx_events_git_commit_identity");
    expect(eventIndexes).not.toContain("idx_events_git_operation_identity");

    closeDatabase(db);
  });

  it("runs migrations only once", () => {
    const path = tempDbPath();
    paths.push(path);

    // Open twice — migrations should not fail
    const db1 = openDatabase(path);
    closeDatabase(db1);

    const db2 = openDatabase(path);
    const migrationCount = db2
      .prepare("SELECT COUNT(*) as count FROM _migrations")
      .get() as { count: number };
    expect(migrationCount.count).toBeGreaterThan(0);
    closeDatabase(db2);
  });

  it("normalizes and merges legacy cloud server URL keys", () => {
    const path = tempDbPath();
    paths.push(path);

    const legacyDb = openDatabase(path);
    legacyDb.prepare("DELETE FROM _migrations WHERE id = 18").run();
    legacyDb.prepare(`
      INSERT INTO sync_state (
        server_url, client_id, last_synced_event_id, last_synced_at, sync_version
      ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
    `).run(
      "http://localhost:3000/",
      "client-1",
      "event-20",
      "2026-08-28T10:00:00.000Z",
      20,
      "http://localhost:3000",
      "client-1",
      "event-10",
      "2026-08-27T10:00:00.000Z",
      10,
    );
    legacyDb.prepare(`
      INSERT INTO project_link_cache (
        project_id, repository_id, server_url, confirmed_project_id,
        last_branch_sync_at, last_doc_sync_at, doc_hashes_json, qualified,
        initialized_at, updated_at, git_ref_heads_json, git_refs_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "project-1",
      "repo-1",
      "http://localhost:3000/",
      "cloud-project-1",
      "2026-08-26T10:00:00.000Z",
      null,
      "{}",
      0,
      "2026-08-26T10:00:00.000Z",
      "2026-08-26T10:00:00.000Z",
      '{"main":"sha-1"}',
      "fingerprint-1",
      "project-1",
      "repo-1",
      "http://localhost:3000",
      null,
      null,
      "2026-08-28T10:00:00.000Z",
      '{"README.md":"hash-1"}',
      0,
      "2026-08-28T10:00:00.000Z",
      "2026-08-28T10:00:00.000Z",
      "{}",
      null,
    );
    closeDatabase(legacyDb);

    const db = openDatabase(path);
    const syncRows = db.prepare("SELECT * FROM sync_state").all() as Array<{
      server_url: string;
      last_synced_event_id: string;
    }>;
    expect(syncRows).toHaveLength(1);
    expect(syncRows[0]).toMatchObject({
      server_url: "http://localhost:3000",
      last_synced_event_id: "event-20",
    });

    const linkRows = db.prepare("SELECT * FROM project_link_cache").all() as Array<{
      server_url: string;
      confirmed_project_id: string | null;
      doc_hashes_json: string;
      git_refs_fingerprint: string | null;
    }>;
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0]).toMatchObject({
      server_url: "http://localhost:3000",
      confirmed_project_id: "cloud-project-1",
      doc_hashes_json: '{"README.md":"hash-1"}',
      git_refs_fingerprint: "fingerprint-1",
    });
    closeDatabase(db);
  });

  it("drops the retired transcript upload table from existing databases", () => {
    const path = tempDbPath();
    paths.push(path);

    const legacyDb = new Database(path);
    legacyDb.exec(`
      CREATE TABLE _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _migrations (id, name)
      VALUES (8, 'create_transcript_uploads');
      CREATE TABLE transcript_uploads (id TEXT PRIMARY KEY);
    `);
    legacyDb.close();

    const db = openDatabase(path);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("transcript_uploads");

    expect(table).toBeUndefined();
    closeDatabase(db);
  });

  it("uses WAL mode", () => {
    const path = tempDbPath();
    paths.push(path);
    const db = openDatabase(path);

    const mode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    expect(mode[0].journal_mode).toBe("wal");

    closeDatabase(db);
  });
});
