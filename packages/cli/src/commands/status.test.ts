import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalStore } from "@varveai/adit-core";
import { daemonStatus } from "../local/daemon.js";
import { statusCommand } from "./status.js";

vi.mock("../local/daemon.js", () => ({ daemonStatus: vi.fn() }));
let root: string, data: string, workspace: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adit-status-"));
  data = join(root, "data");
  workspace = join(root, "workspace");
  mkdirSync(workspace);
  vi.stubEnv("ADIT_LOCAL_DATA_DIR", data);
  vi.spyOn(process, "cwd").mockReturnValue(workspace);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(daemonStatus).mockReset().mockResolvedValue(null);
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});
const output = () => String(vi.mocked(console.log).mock.calls.at(-1)?.[0]);
const instance = {
  pid: 1234,
  url: "http://127.0.0.1:4567",
  token: "do-not-print",
  instance: "private-instance",
};

it("reports a stopped service outside a workspace without creating storage", async () => {
  await statusCommand({ json: true });
  expect(JSON.parse(output())).toMatchObject({
    workspaceState: "uninitialized",
    backgroundRunning: false,
    daemon: { state: "stopped", pid: null, url: null, port: null },
  });
  expect(existsSync(data)).toBe(false);
  expect(process.exitCode).toBeUndefined();
});

it.each([false, true])(
  "reports service details without exposing internal credentials (busy=%s)",
  async (busy) => {
    vi.mocked(daemonStatus).mockResolvedValue({ ...instance, busy });
    await statusCommand({ json: true });
    expect(JSON.parse(output())).toMatchObject({
      backgroundRunning: true,
      daemon: { state: busy ? "busy" : "running", pid: 1234, port: 4567, url: instance.url },
    });
    expect(output()).not.toContain(instance.token);
    expect(output()).not.toContain(instance.instance);
    await statusCommand();
    expect(output()).toContain(`Service: ${busy ? "Running (busy)" : "Running"}`);
    expect(output()).toContain("Port: 4567");
    expect(output()).toContain("PID: 1234");
    expect(output()).toContain("Current directory is not initialized");
  },
);

it("retains existing workspace JSON fields and reads without changing settings", async () => {
  const store = new LocalStore(data);
  const saved = store.saveWorkspace({ path: workspace, providers: [], repositories: [] });
  const before = store.db.prepare("SELECT * FROM adit_local_settings").all();
  try {
    await statusCommand({ json: true });
    expect(JSON.parse(output())).toMatchObject({
      projectId: saved.id,
      name: saved.name,
      path: saved.path,
      storage: store.dbPath,
      git: { available: false },
      started: saved.started,
      nativeSources: [],
      sessions: 0,
      cloud: saved.cloud,
      backgroundRunning: false,
      workspaceState: "initialized",
    });
    expect(store.db.prepare("SELECT * FROM adit_local_settings").all()).toEqual(before);
    await statusCommand();
    expect(output()).toContain(`Workspace: ${saved.name}`);
    expect(output()).toContain("Sessions: 0");
  } finally {
    store.close();
  }
});

it("reports service inspection failures as errors instead of stopped", async () => {
  vi.mocked(daemonStatus).mockRejectedValue(new Error("Process access denied"));
  await statusCommand({ json: true });
  expect(JSON.parse(output())).toMatchObject({
    backgroundRunning: null,
    daemon: { state: "error", error: "Process access denied" },
  });
  expect(process.exitCode).toBe(1);
});

it("preserves service information when workspace data is corrupt", async () => {
  const store = new LocalStore(data);
  const saved = store.saveWorkspace({ path: workspace, providers: [], repositories: [] });
  store.db.prepare("UPDATE adit_local_workspaces SET data='broken' WHERE id=?").run(saved.id);
  store.close();
  vi.mocked(daemonStatus).mockResolvedValue(instance);
  await statusCommand({ json: true });
  expect(JSON.parse(output())).toMatchObject({
    workspaceState: "error",
    error: expect.any(String),
    daemon: { state: "running", pid: 1234 },
  });
  expect(process.exitCode).toBe(1);
});

it.each([
  { providers: undefined },
  { providers: "codex" },
  { providers: [null] },
  { cloud: undefined },
  { cloud: { enabled: "yes", mode: "manual", interval: 5 } },
  { cloud: { enabled: true, mode: "invalid", interval: 5 } },
  { cloud: { enabled: true, mode: "manual", interval: null } },
  { started: "yes" },
])("preserves service status and reports invalid workspace fields: %j", async (invalid) => {
  const store = new LocalStore(data);
  try {
    const saved = store.saveWorkspace({ path: workspace, providers: [], repositories: [] });
    store.db
      .prepare("UPDATE adit_local_workspaces SET data=? WHERE id=?")
      .run(JSON.stringify({ ...saved, ...invalid }), saved.id);
  } finally {
    store.close();
  }
  vi.mocked(daemonStatus).mockResolvedValue(instance);
  await statusCommand({ json: true });
  expect(JSON.parse(output())).toMatchObject({
    workspaceState: "error",
    error: expect.stringContaining("missing or invalid fields"),
    daemon: { state: "running", pid: 1234 },
  });
  expect(process.exitCode).toBe(1);
  process.exitCode = undefined;
  await expect(statusCommand()).resolves.toBeUndefined();
  expect(output()).toContain("Service: Running");
  expect(output()).toContain("PID: 1234");
  expect(output()).toContain(
    "Workspace error: Workspace record contains missing or invalid fields",
  );
  expect(process.exitCode).toBe(1);
});
