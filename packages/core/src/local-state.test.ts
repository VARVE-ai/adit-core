import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-state.js";

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
  const w = store.saveWorkspace({
    path,
    cloud: { enabled: true, mode: "automatic", interval: 60 },
  });
  store.saveSchedule({ version: 0, enabled: false, interval: 15 });
  expect(store.workspace(w.id).cloud.interval).toBe(60);
  expect(store.schedule().enabled).toBe(false);
  expect(store.jobs()).toEqual([]);
});
