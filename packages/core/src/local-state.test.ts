import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore, localLoginStartupEnabled } from "./local-state.js";

const resources: { root: string; store: LocalStore }[] = [];
afterEach(() => {
  for (const r of resources.splice(0)) {
    r.store.close();
    rmSync(r.root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adit-state-test-"));
  const path = join(root, "project");
  mkdirSync(path);
  const store = new LocalStore(join(root, "state"));
  resources.push({ root, store });
  return { store, path };
}
it("persists distinct stable device and project identities", () => {
  const { store, path } = fixture();
  const client = store.identity("client", "existing-device");
  const w = store.saveWorkspace({ path, providers: [], repositories: [] });
  expect(store.identity("client")).toBe(client);
  expect(w.id).not.toBe(client);
  expect(
    store.saveWorkspace({ version: w.version, name: "renamed" }, w.id).id,
  ).toBe(w.id);
});
it("rejects duplicates, stale updates and invalid configuration atomically", () => {
  const { store, path } = fixture();
  const w = store.saveWorkspace({ path });
  expect(() => store.saveWorkspace({ path })).toThrow(/already exists/);
  expect(() => store.saveWorkspace({ version: 0, name: "bad" }, w.id)).toThrow(
    /another window/,
  );
  expect(() =>
    store.saveWorkspace(
      {
        version: w.version,
        name: "bad",
        cloud: { enabled: true, mode: "automatic", interval: 12 },
      },
      w.id,
    ),
  ).toThrow(/interval/);
  expect(store.workspace(w.id)).toEqual(w);
});
it("keeps per-directory cloud settings independent from local collection", () => {
  const { store, path } = fixture();
  store.set("login-startup", { enabled: true });
  const w = store.saveWorkspace({
    path,
    cloud: { enabled: true, mode: "automatic", interval: 60 },
  });
  store.saveSchedule({ version: 0, enabled: false, interval: 15 });
  expect(store.workspace(w.id).cloud.interval).toBe(60);
  expect(store.schedule().enabled).toBe(false);
  expect(store.jobs()).toEqual([]);
});
it("defaults new cloud settings to automatic without enabling uploads or replacing explicit manual settings", () => {
  const { store, path } = fixture();
  store.set("login-startup", { enabled: true });
  const workspace = store.saveWorkspace({ path });
  expect(workspace.cloud).toEqual({ enabled: false, mode: "automatic", interval: 5 });
  const manual = store.saveWorkspace({ version: workspace.version, cloud: { enabled: true, mode: "manual", interval: 15 } }, workspace.id);
  expect(store.saveWorkspace({ version: manual.version, name: "renamed" }, workspace.id).cloud).toEqual(manual.cloud);
});
it("removes only the workspace registration and its jobs, preserving files and other workspaces", () => {
  const { store, path } = fixture();
  const file = join(path, "keep.txt");
  writeFileSync(file, "source file");
  const first = store.saveWorkspace({ path });
  const nested = join(path, "nested");
  mkdirSync(nested);
  const other = store.saveWorkspace({ path: nested });
  store.job({ id: "removed", workspaceId: first.id, status: "done" });
  store.job({ id: "kept", workspaceId: other.id, status: "done" });
  expect(() => store.deleteWorkspace(first.id, first.version + 1)).toThrow(/changed/);
  expect(store.workspaces()).toHaveLength(2);
  store.deleteWorkspace(first.id, first.version);
  expect(store.workspaces()).toEqual([other]);
  expect(store.jobs()).toEqual([{ id: "kept", workspaceId: other.id, status: "done" }]);
  expect(existsSync(file)).toBe(true);
  expect(() => store.workspace(first.id)).toThrow(/not found/);
  expect(() => store.deleteWorkspace(first.id, first.version)).toThrow(/not found/);
  expect(store.saveWorkspace({ path }).id).not.toBe(first.id);
});
it("rejects deletion while queued or running, even when the job is older than the latest 100 jobs", () => {
  const { store, path } = fixture();
  const workspace = store.saveWorkspace({ path });
  store.job({ id: "active", workspaceId: workspace.id, status: "queued" });
  for (let i = 0; i < 101; i++) store.job({ id: `other-${i}`, workspaceId: "other", status: "done" });
  expect(() => store.deleteWorkspace(workspace.id, workspace.version)).toThrow(/finish/);
  store.job({ id: "active", workspaceId: workspace.id, status: "running" });
  expect(() => store.deleteWorkspace(workspace.id, workspace.version)).toThrow(/finish/);
  expect(store.workspace(workspace.id)).toEqual(workspace);
  store.job({ id: "active", workspaceId: workspace.id, status: "done" });
  store.deleteWorkspace(workspace.id, workspace.version);
  expect(store.workspaces()).toEqual([]);
});
it("requires explicit login-startup consent and reads it without creating a database", () => {
  const { store, path } = fixture();
  const missing = join(path, "absent");
  expect(localLoginStartupEnabled(missing)).toBe(false);
  expect(existsSync(missing)).toBe(false);
  expect(() => store.saveWorkspace({ path, cloud: { enabled: true, mode: "automatic", interval: 5 } })).toThrow(/Start automatically/);
  const registration = join(path, "startup-entry");
  store.set("login-startup", { enabled: true, version: 1, registration });
  expect(localLoginStartupEnabled(store.directory)).toBe(false);
  writeFileSync(registration, "test");
  expect(localLoginStartupEnabled(store.directory)).toBe(true);
  store.set("login-startup", { enabled: false, version: 2, registration });
  expect(localLoginStartupEnabled(store.directory)).toBe(false);
});
