/**
 * Tests for shared hook context session selection.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  closeDatabase,
  createClock,
  insertSession,
  loadConfig,
  openDatabase,
  serialize,
  writeProjectManifest,
} from "@varveai/adit-core";
import type Database from "better-sqlite3";

vi.mock("@varveai/adit-engine", () => ({
  getCurrentBranch: vi.fn().mockResolvedValue("main"),
  getRemoteUrl: vi.fn().mockResolvedValue("git@example.com:repo.git"),
}));

async function loadContextModule(): Promise<typeof import("./context.js")> {
  vi.resetModules();
  return import("./context.js");
}

function tempDir(): string {
  const dir = join(tmpdir(), `adit-hook-context-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("initHookContext", () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let projectId: string;
  const clientId = "client-1";

  beforeEach(() => {
    dir = tempDir();
    mkdirSync(join(dir, ".adit"), { recursive: true });
    dbPath = join(dir, ".adit", "adit.sqlite");
    const now = new Date().toISOString();
    writeProjectManifest(dir, {
      schemaVersion: 1,
      projectId: "11111111-2222-4333-8444-555555555555",
      projectType: "repo",
      repositories: [{ relativePath: "." }],
      createdAt: now,
      updatedAt: now,
    });
    process.env.ADIT_PROJECT_ROOT = dir;
    process.env.ADIT_DATA_DIR = join(dir, ".adit");
    process.env.ADIT_DB_PATH = dbPath;
    process.env.ADIT_CLIENT_ID = clientId;
    db = openDatabase(dbPath);
    projectId = loadConfig(dir).projectId;
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    delete process.env.ADIT_PROJECT_ROOT;
    delete process.env.ADIT_DATA_DIR;
    delete process.env.ADIT_DB_PATH;
    delete process.env.ADIT_CLIENT_ID;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("creates a new platform session instead of reusing another platform's active session", async () => {
    insertSession(db, {
      id: "claude-session",
      projectId,
      clientId,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: "2026-05-11T02:00:00.000Z",
      vclockJson: serialize(createClock(clientId)),
      platformSessionId: "claude-platform-session",
    });

    const { initHookContext } = await loadContextModule();
    const ctx = await initHookContext(
      dir,
      "codex",
      "codex-platform-session",
      { projectRoot: dir },
    );

    expect(ctx?.session.id).not.toBe("claude-session");
    expect(ctx?.session.platform).toBe("codex");
    expect(ctx?.session.platformSessionId).toBe("codex-platform-session");

    closeDatabase(ctx!.db);
  });

  it("reattaches to the same platform session id without duplicating", async () => {
    insertSession(db, {
      id: "resumed-session",
      projectId,
      clientId,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: "2026-05-11T02:00:00.000Z",
      vclockJson: serialize(createClock(clientId)),
      platformSessionId: "claude-platform-resume",
    });
    const { initHookContext } = await loadContextModule();
    const ctx = await initHookContext(
      dir,
      "claude-code",
      "claude-platform-resume",
      { projectRoot: dir },
    );

    expect(ctx?.session.id).toBe("resumed-session");
    const row = ctx!.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    expect(row.count).toBe(1);

    closeDatabase(ctx!.db);
  });

  it("ignores hooks without a platform session id instead of guessing a session", async () => {
    insertSession(db, {
      id: "legacy-session",
      projectId,
      clientId,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: "2026-05-11T02:00:00.000Z",
      vclockJson: serialize(createClock(clientId)),
    });

    const { initHookContext } = await loadContextModule();
    const ctx = await initHookContext(dir, "claude-code", undefined, { projectRoot: dir });

    expect(ctx).toBeNull();
    const row = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    expect(row.count).toBe(1);
  });

  it("uses fixed project root for config and DB while preserving runtime cwd metadata", async () => {
    delete process.env.ADIT_PROJECT_ROOT;
    delete process.env.ADIT_DATA_DIR;
    delete process.env.ADIT_DB_PATH;

    const workspaceRoot = join(dir, "workspace");
    const childRepo = join(workspaceRoot, "adit-core");
    mkdirSync(join(childRepo, ".git"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".adit"), { recursive: true });
    const now = new Date().toISOString();
    writeProjectManifest(workspaceRoot, {
      schemaVersion: 1,
      projectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      projectType: "workspace",
      repositories: [{ relativePath: "adit-core" }],
      createdAt: now,
      updatedAt: now,
    });
    const workspaceDbPath = join(workspaceRoot, ".adit", "adit.sqlite");
    closeDatabase(openDatabase(workspaceDbPath));

    const { initHookContext } = await loadContextModule();
    const ctx = await initHookContext(
      childRepo,
      "codex",
      "codex-platform-session",
      { projectRoot: workspaceRoot },
    );

    expect(ctx?.config.projectRoot).toBe(workspaceRoot);
    expect(ctx?.config.dbPath).toBe(workspaceDbPath);
    expect(ctx?.session.metadataJson).toContain(`"workingDirectory":"${childRepo}"`);

    closeDatabase(ctx!.db);
  });

  it("does not create a database when fixed project root is not initialized", async () => {
    delete process.env.ADIT_PROJECT_ROOT;
    delete process.env.ADIT_DATA_DIR;
    delete process.env.ADIT_DB_PATH;

    const uninitializedRoot = join(dir, "uninitialized");
    const driftedCwd = join(uninitializedRoot, "child");
    mkdirSync(driftedCwd, { recursive: true });

    const { initHookContext } = await loadContextModule();
    const ctx = await initHookContext(
      driftedCwd,
      "codex",
      "codex-platform-session",
      { projectRoot: uninitializedRoot },
    );

    expect(ctx).toBeNull();
    expect(existsSync(join(uninitializedRoot, ".adit"))).toBe(false);
  });

  it("skips old hook commands without fixed project root", async () => {
    const { initHookContext } = await loadContextModule();
    const ctx = await initHookContext(dir, "codex", "codex-platform-session");

    expect(ctx).toBeNull();
  });
});
