import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { LocalStore } from "@varveai/adit-core";
import { daemonStatus, startDaemon } from "./daemon.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(() => { throw new Error("Unexpected daemon spawn"); }),
}));

let root: string, store: LocalStore;
const instance = { pid: process.pid, instance: "fixture-instance", url: "http://127.0.0.1:12345", token: "fixture-token" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adit-daemon-status-"));
  vi.stubEnv("ADIT_LOCAL_DATA_DIR", root);
  store = new LocalStore(root);
  store.set("daemon-lock", { pid: instance.pid, instance: instance.instance });
  writeFileSync(join(root, "daemon.json"), JSON.stringify(instance));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Health timed out")));
  vi.mocked(spawn).mockClear();
});

afterEach(() => {
  store.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("recognizes a live locked daemon as busy without spawning a duplicate", async () => {
  expect(await daemonStatus()).toEqual({ ...instance, busy: true });
  expect(await startDaemon()).toEqual({ ...instance, busy: true });
  expect(spawn).not.toHaveBeenCalled();
});

it("requires both the live process and matching instance lock for the busy fallback", async () => {
  store.set("daemon-lock", { pid: instance.pid, instance: "different-instance" });
  expect(await daemonStatus()).toBeNull();
  store.set("daemon-lock", { pid: instance.pid, instance: instance.instance });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("No such process"); });
  expect(await daemonStatus()).toBeNull();
  kill.mockRestore();
  store.db.prepare("DELETE FROM adit_local_settings WHERE key='daemon-lock'").run();
  expect(await daemonStatus()).toBeNull();
});

it("rejects mismatched health responses and returns the healthy service version", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ service: "other-service", instance: instance.instance })));
  expect(await daemonStatus()).toBeNull();
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ service: "adit-local", instance: "different" })));
  expect(await daemonStatus()).toBeNull();
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ service: "adit-local", instance: instance.instance, version: "1.1.4" })));
  expect(await daemonStatus()).toEqual({ ...instance, version: "1.1.4" });
});
