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

  it("reuses active session only when no platform session id is available", async () => {
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

    expect(ctx?.session.id).toBe("legacy-session");

    closeDatabase(ctx!.db);
  });

  it("uses fixed project root for config and DB while preserving runtime cwd metadata", async () => {
    delete process.env.ADIT_PROJECT_ROOT;
    delete process.env.ADIT_DATA_DIR;
    delete process.env.ADIT_DB_PATH;

    const workspaceRoot = join(dir, "workspace");
    const childRepo = join(workspaceRoot, "adit-core");
    mkdirSync(join(childRepo, ".git"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".adit"), { recursive: true });
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
