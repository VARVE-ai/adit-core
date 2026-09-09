/**
 * Tests for shared hook context session selection.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const testHome = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => testHome.path,
}));

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
    testHome.path = dir;
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

  it("attaches a client-side fork to the original project even after entering an independent child", async () => {
    const originalPsid = "claude-original";
    const forkPsid = "claude-fork";
    const transcriptsDir = join(dir, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    const line = (type: string, uuid: string, sessionId: string) =>
      JSON.stringify({ type, uuid, sessionId, message: { role: type, content: [{ type: "text", text: "x" }] } });
    writeFileSync(
      join(transcriptsDir, `${originalPsid}.jsonl`),
      [line("user", "u1", originalPsid), line("assistant", "a1", originalPsid), line("user", "u2", originalPsid)].join("\n") + "\n",
    );
    const forkPath = join(transcriptsDir, `${forkPsid}.jsonl`);
    writeFileSync(
      forkPath,
      [line("user", "u1", forkPsid), line("assistant", "a1", forkPsid), line("user", "u2-edited", forkPsid)].join("\n") + "\n",
    );
    insertSession(db, {
      id: "original-session",
      projectId,
      clientId,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      vclockJson: serialize(createClock(clientId)),
      platformSessionId: originalPsid,
    });

    const child = join(dir, "test4");
    mkdirSync(join(child, ".git"), { recursive: true });
    const now = new Date().toISOString();
    writeProjectManifest(child, { schemaVersion: 3, projectId: "child", repositories: [{ relativePath: "." }], createdAt: now, updatedAt: now });
    closeDatabase(openDatabase(join(child, ".adit", "adit.sqlite")));
    const { initHookContext } = await loadContextModule();
    const first = await initHookContext(child, "claude-code", forkPsid, {
      projectRoot: child,
      transcriptPath: forkPath,
    });
    expect(first?.session.id).toBe("original-session");
    closeDatabase(first!.db);

    // Later hooks for the fork id resolve through the alias — still one session.
    const again = await initHookContext(dir, "claude-code", forkPsid, { projectRoot: dir });
    expect(again?.session.id).toBe("original-session");
    const row = again!.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    expect(row.count).toBe(1);
    const alias = again!.db
      .prepare("SELECT session_id FROM session_platform_aliases WHERE platform_session_id = ?")
      .get(forkPsid) as { session_id: string } | undefined;
    expect(alias?.session_id).toBe("original-session");
    closeDatabase(again!.db);
  });

  it("starts a new session when the transcript does not continue an existing one", async () => {
    const transcriptsDir = join(dir, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    const freshPath = join(transcriptsDir, "claude-fresh.jsonl");
    writeFileSync(freshPath, JSON.stringify({ type: "user", uuid: "z1", sessionId: "claude-fresh" }) + "\n");
    insertSession(db, {
      id: "other-session",
      projectId,
      clientId,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: serialize(createClock(clientId)),
      platformSessionId: "claude-other",
    });
    writeFileSync(join(transcriptsDir, "claude-other.jsonl"), JSON.stringify({ type: "user", uuid: "o1", sessionId: "claude-other" }) + "\n");

    const { initHookContext } = await loadContextModule();
    const ctx = await initHookContext(dir, "claude-code", "claude-fresh", {
      projectRoot: dir,
      transcriptPath: freshPath,
    });
    expect(ctx?.session.id).not.toBe("other-session");
    expect(JSON.parse(ctx!.session.metadataJson ?? "{}").transcriptPath).toBe(freshPath);
    const row = ctx!.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    expect(row.count).toBe(2);
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

  it("binds a conversation once across parent/child hooks, cwd changes and module reloads", async () => {
    const child = join(dir, "test4");
    mkdirSync(join(child, ".git"), { recursive: true });
    const now = new Date().toISOString();
    writeProjectManifest(child, {
      schemaVersion: 3, projectId: "test4-independent", repositories: [{ relativePath: "." }],
      createdAt: now, updatedAt: now,
    });
    closeDatabase(openDatabase(join(child, ".adit", "adit.sqlite")));
    const firstModule = await loadContextModule();
    const parent = await firstModule.initHookContext(dir, "codex", "parent-session", { projectRoot: dir });
    const parentSessionId = parent!.session.id;
    closeDatabase(parent!.db);
    const reloaded = await loadContextModule();
    const continued = await reloaded.initHookContext(child, "codex", "parent-session", { projectRoot: child });
    expect(continued!.session.id).toBe(parentSessionId);
    expect(continued!.config.projectRoot).toBe(dir);
    closeDatabase(continued!.db);
    // A fresh conversation launched from the child picks the child even if
    // the platform also invokes the inherited parent hook.
    const own = await reloaded.initHookContext(child, "codex", "child-session", { projectRoot: dir });
    expect(own!.session.projectId).toBe("test4-independent");
    const childSessionId = own!.session.id;
    closeDatabase(own!.db);
    const ownContinued = await reloaded.initHookContext(dir, "codex", "child-session", { projectRoot: child });
    expect(ownContinued!.session.id).toBe(childSessionId);
    expect(ownContinued!.config.projectRoot).toBe(child);
    closeDatabase(ownContinued!.db);
    expect((db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count).toBe(1);
  });

  it("keeps pre-upgrade parent history when a child installs its own hooks", async () => {
    insertSession(db, {
      id: "before-upgrade", projectId, clientId, sessionType: "interactive", platform: "codex",
      startedAt: new Date().toISOString(), vclockJson: serialize(createClock(clientId)),
      platformSessionId: "legacy-parent-session",
    });
    const child = join(dir, "test4");
    mkdirSync(join(child, ".git"), { recursive: true });
    const now = new Date().toISOString();
    writeProjectManifest(child, { schemaVersion: 3, projectId: "test4", repositories: [{ relativePath: "." }], createdAt: now, updatedAt: now });
    closeDatabase(openDatabase(join(child, ".adit", "adit.sqlite")));
    const { initHookContext } = await loadContextModule();
    const result = await initHookContext(child, "codex", "legacy-parent-session", { projectRoot: child });
    expect(result!.session.id).toBe("before-upgrade");
    expect(result!.config.projectRoot).toBe(dir);
    closeDatabase(result!.db);
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
