import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Worker as NodeWorker } from "node:worker_threads";
import {
  LocalAchievements,
  LocalHistory,
  LocalInspection,
  LocalStore,
  type OverviewData,
} from "@varveai/adit-core";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { OnDemandWorker } from "./on-demand-worker.js";

const { threads } = vi.hoisted(() => ({
  threads: [] as { worker: NodeWorker; exited: Promise<number> }[],
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        threads.push({
          worker: this,
          exited: new Promise<number>((finish) => this.once("exit", finish)),
        });
      }
    },
  };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  threads.length = 0;
});

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), "adit-background-worker-"));
  const store = new LocalStore(join(root, "state"));
  new LocalHistory(store.db);
  const history = new StructuredHistory(store.db);
  const workspace = store.saveWorkspace({
    path: root,
    providers: ["claude"],
    repositories: [],
  });
  history.write({
    provider: "claude",
    id: "fixture",
    cwd: root,
    messages: [
      { key: "user", role: "user", content: "question", raw: {} },
      { key: "assistant", role: "assistant", content: "answer", raw: {} },
    ],
  });
  const instance = new OnDemandWorker(
    new URL(`../../dist/local/${name}-worker.js`, import.meta.url),
    { path: store.dbPath },
    () => new Error("Worker unavailable"),
    { idleTimeout: name === "overview" ? 10 : 0 },
  );
  cleanups.push(async () => {
    await instance.close();
    store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error("Unexpected fixture directory");
    rmSync(root, { recursive: true, force: true });
  });
  return { instance, store, workspace };
}

it("closes the real inspection thread cleanly and reopens it for subsequent scans", async () => {
  const { instance, store, workspace } = fixture("inspection");
  const inspection = new LocalInspection(store.db);
  expect(threads).toHaveLength(0);
  for (let scan = 1; scan <= 2; scan++) {
    const runId = inspection.start(workspace);
    await instance.request<void>({ runId, workspace, force: true });
    expect(
      store.db
        .prepare("SELECT status,total,completed FROM adit_history_secret_scan_runs WHERE id=?")
        .get(runId),
    ).toMatchObject({ status: "done", total: 1, completed: 1 });
    expect(threads).toHaveLength(scan);
    expect(await threads[scan - 1].exited).toBe(0);
    expect(threads[scan - 1].worker.threadId).toBe(-1);
  }
});

it("closes the real achievement thread and preserves evaluations across restarts", async () => {
  const { instance, store, workspace } = fixture("achievement");
  const achievements = new LocalAchievements(store.db);
  expect(threads).toHaveLength(0);
  for (let sourceErrors = 0; sourceErrors <= 1; sourceErrors++) {
    await instance.request<void>({ workspace, sourceErrors });
    expect(achievements.read(workspace)).toMatchObject({
      status: "ready",
      sourceErrors,
    });
    expect(threads).toHaveLength(sourceErrors + 1);
    expect(await threads[sourceErrors].exited).toBe(0);
    expect(threads[sourceErrors].worker.threadId).toBe(-1);
  }
});

it("releases the real overview thread after idle and calculates again after reopening", async () => {
  const { instance, workspace } = fixture("overview");
  expect(threads).toHaveLength(0);
  for (let query = 1; query <= 2; query++) {
    const data = await instance.request<OverviewData>({
      workspace,
      options: { range: "all", timezone: "UTC", year: 2026 },
    });
    expect(data.summary.sessions).toBe(1);
    expect(threads).toHaveLength(query);
    expect(await threads[query - 1].exited).toBe(0);
    expect(threads[query - 1].worker.threadId).toBe(-1);
  }
});
