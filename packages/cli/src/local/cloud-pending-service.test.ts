import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalHistory, LocalStore } from "@varveai/adit-core";
import { loadCredentials } from "@varveai/adit-cloud";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { CloudPendingService } from "./cloud-pending-service.js";
import { cloudPending, type PendingSessionCache } from "./cloud-pending.js";
import { createCloudPendingSchema, pendingRevision } from "./cloud-pending-schema.js";
import { createCloudSyncSchema, syncKey, type CloudBaseline } from "./cloud-projection.js";
import { OnDemandWorker } from "./on-demand-worker.js";
import { startLocalServer } from "./server.js";

vi.mock("@varveai/adit-cloud", async importOriginal => ({
  ...await importOriginal<typeof import("@varveai/adit-cloud")>(), loadCredentials: vi.fn(),
}));

let root: string, store: LocalStore, history: StructuredHistory;
let service: CloudPendingService;
let workspace: ReturnType<LocalStore["workspace"]>;
let scope: string;
const baseline: CloudBaseline = { schemaVersion: 1, accountId: "user", before: null, repositories: [], sessions: [], nextCursor: null };
const credentials = { clientId: "device", accountId: "user", credentialId: "credential", serverUrl: "http://localhost:3000", accessToken: "test", refreshToken: "", expiresAt: "", authType: "token" as const };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adit-pending-service-"));
  mkdirSync(join(root, ".git"));
  store = new LocalStore(join(root, "data"));
  store.saveSchedule({ ...store.schedule(), enabled: false });
  new LocalHistory(store.db);
  history = new StructuredHistory(store.db);
  createCloudSyncSchema(store);
  createCloudPendingSchema(store.db);
  workspace = store.saveWorkspace({ path: root, providers: ["codex"], repositories: [], cloud: { enabled: true, mode: "manual", interval: 5 } });
  scope = syncKey(credentials.serverUrl, credentials.accountId, workspace.id);
  store.db.prepare("INSERT INTO adit_local_cloud_scopes VALUES (?,?,?)").run(scope, workspace.id, JSON.stringify(baseline));
  service = new CloudPendingService(store, new URL("../../dist/local/cloud-pending-worker.js", import.meta.url));
  vi.mocked(loadCredentials).mockReturnValue(credentials);
});

afterEach(async () => {
  await service.close();
  store.close();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function writeSession(id: string, extra = false) {
  history.write({ provider: "codex", id, cwd: root, messages: [
    { key: "prompt", role: "user", content: "question", timestamp: "2026-10-20T00:00:00Z", raw: {} },
    { key: "answer", role: "assistant", content: "answer", timestamp: "2026-10-20T00:00:01Z", finalReply: true, raw: {} },
    ...(extra ? [{ key: "next", role: "user", content: "next", timestamp: "2026-10-20T00:00:02Z", raw: {} }] : []),
  ] });
}

async function ready() {
  await expect.poll(() => {
    const value = service.read(workspace, scope);
    expect(value.error).toBeUndefined();
    return value.state === "ready" && !value.refreshing;
  }, { timeout: 10000 }).toBe(true);
  return service.read(workspace, scope);
}

it("returns unknown counts immediately, deduplicates polling and ignores unrelated writes", async () => {
  writeSession("first");
  const request = vi.spyOn(OnDemandWorker.prototype, "request");
  const prepare = vi.spyOn(store.db, "prepare");
  for (let attempt = 0; attempt < 50; attempt++)
    expect(service.read(workspace, scope)).toEqual({ state: "computing", sessions: null, commits: null });
  expect(request).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls.every(([sql]) => sql.includes("adit_local_pending_revisions"))).toBe(true);
  expect(await ready()).toEqual({ state: "ready", sessions: 1, commits: 0 });
  const previous = service.read(workspace, scope);
  store.set("unrelated-setting", { enabled: true });
  store.job({ id: "progress", status: "running" });
  expect(service.read(workspace, scope)).toBe(previous);
  expect(request).toHaveBeenCalledTimes(1);
  const other = new LocalStore(store.directory);
  try { other.set("unrelated-worker-progress", 1); }
  finally { other.close(); }
  expect(service.read(workspace, scope)).toBe(previous);
  expect(request).toHaveBeenCalledTimes(1);
  writeSession("second");
  expect(service.read(workspace, scope)).toEqual({ state: "ready", sessions: 1, commits: 0, refreshing: true });
  expect(await ready()).toEqual({ state: "ready", sessions: 2, commits: 0 });
  expect(request).toHaveBeenCalledTimes(2);
});

it("reuses unchanged sessions, invalidates only changed transcripts, and preserves the original count", () => {
  writeSession("first"); writeSession("second");
  const inherited = { ...baseline, before: "2026-10-21T00:00:00Z" };
  const cache: PendingSessionCache = new Map();
  const original = store.db.prepare.bind(store.db);
  const checked: string[] = [];
  vi.spyOn(store.db, "prepare").mockImplementation(sql => {
    const statement = original(sql);
    if (sql.includes("t.prompt_message_id,m.occurred_at")) {
      const all = statement.all.bind(statement);
      statement.all = (...parameters: unknown[]) => { checked.push(String(parameters[1])); return all(...parameters); };
    }
    return statement;
  });
  expect(cloudPending(store, workspace, scope, inherited, cache)).toEqual(cloudPending(store, workspace, scope, inherited));
  checked.length = 0;
  expect(cloudPending(store, workspace, scope, inherited, cache)).toEqual({ state: "ready", sessions: 0, commits: 0 });
  expect(checked).toEqual([]);
  writeSession("first", true);
  cloudPending(store, workspace, scope, inherited, cache);
  expect(checked).toEqual(["first"]);
  const before = pendingRevision(store.db);
  store.db.prepare("INSERT INTO adit_history_sources VALUES ('codex','source','first','old',1)").run();
  const identity = pendingRevision(store.db, "identity");
  const afterSource = pendingRevision(store.db);
  store.db.prepare("UPDATE adit_history_sources SET fingerprint='new'").run();
  expect(pendingRevision(store.db, "identity")).toBe(identity);
  expect(pendingRevision(store.db)).toBe(afterSource);
  expect(pendingRevision(store.db)).toBeGreaterThan(before);
  checked.length = 0;
  cloudPending(store, workspace, scope, inherited, cache);
  expect(checked.sort()).toEqual(["first", "second"]);
  checked.length = 0;
  store.db.prepare("INSERT INTO adit_local_cloud_receipts VALUES (?, 'event', 'ack', 1)").run(scope);
  cloudPending(store, workspace, scope, inherited, cache);
  expect(checked.sort()).toEqual(["first", "second"]);
  store.db.prepare("DELETE FROM adit_history_sessions WHERE id='second'").run();
  cloudPending(store, workspace, scope, inherited, cache);
  expect(cache.has(JSON.stringify(["codex", "second"]))).toBe(false);
});

it("matches uncached counts for hundreds of sessions and reuses results after worker retirement", async () => {
  const inherited = { ...baseline, before: "2026-10-21T00:00:00Z" };
  store.db.prepare("UPDATE adit_local_cloud_scopes SET baseline=? WHERE id=?").run(JSON.stringify(inherited), scope);
  for (let sessionIndex = 0; sessionIndex < 269; sessionIndex++) {
    const messages = Array.from({ length: 16 }, (_, turnIndex) => [
      { key: `prompt-${turnIndex}`, role: "user", content: "question", timestamp: "2026-10-20T00:00:00Z", raw: {} },
      { key: `answer-${turnIndex}`, role: "assistant", content: "answer", timestamp: "2026-10-20T00:00:01Z", finalReply: true, raw: {} },
    ]).flat();
    history.write({ provider: "codex", id: `session-${sessionIndex}`, cwd: root, messages });
  }
  const expected = cloudPending(store, workspace, scope, inherited);
  const request = vi.spyOn(OnDemandWorker.prototype, "request");
  expect(await ready()).toEqual(expected);
  expect(expected).toEqual({ state: "ready", sessions: 0, commits: 0 });
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(service.read(workspace, scope)).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(1);
  writeSession("new-session");
  expect(await ready()).toEqual(cloudPending(store, workspace, scope, inherited));
  expect(request).toHaveBeenCalledTimes(2);
}, 15000);

it("refreshes again when relevant writes commit during an in-flight snapshot", async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  const request = vi.spyOn(OnDemandWorker.prototype, "request").mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
  const revision = pendingRevision(store.db);
  service.read(workspace, scope);
  writeSession("first");
  for (let attempt = 0; attempt < 10; attempt++) service.read(workspace, scope);
  expect(request).toHaveBeenCalledTimes(1);
  resolvers[0]({ revision, value: { state: "ready", sessions: 0, commits: 0 }, sessions: [] });
  await new Promise(resolve => setImmediate(resolve));
  expect(service.read(workspace, scope)).toEqual({ state: "ready", sessions: 0, commits: 0, refreshing: true });
  expect(request).toHaveBeenCalledTimes(2);
  resolvers[1]({ revision: pendingRevision(store.db), value: { state: "ready", sessions: 1, commits: 0 }, sessions: [] });
  await new Promise(resolve => setImmediate(resolve));
  expect(service.read(workspace, scope)).toEqual({ state: "ready", sessions: 1, commits: 0 });
});

it("discards in-flight results after an account switch or deletion", async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  vi.spyOn(OnDemandWorker.prototype, "request").mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
  expect(service.read(workspace, scope).state).toBe("computing");
  const otherScope = "other-account";
  expect(service.read(workspace, otherScope).state).toBe("computing");
  resolvers[0]({ revision: pendingRevision(store.db), value: { state: "ready", sessions: 99, commits: 0 }, sessions: [] });
  await new Promise(resolve => setImmediate(resolve));
  expect(service.read(workspace, otherScope).state).toBe("computing");
  service.forget(workspace.id);
  resolvers[1]({ revision: pendingRevision(store.db), value: { state: "ready", sessions: 88, commits: 0 }, sessions: [] });
  await new Promise(resolve => setImmediate(resolve));
  expect(service.read(workspace, otherScope).state).toBe("computing");
  resolvers[2]({ revision: pendingRevision(store.db), value: { state: "ready", sessions: 1, commits: 0 }, sessions: [] });
  await new Promise(resolve => setImmediate(resolve));
  expect(service.read(workspace, otherScope)).toEqual({ state: "ready", sessions: 1, commits: 0 });
});

it("keeps the previous count on worker failure and backs off instead of retrying every poll", async () => {
  writeSession("first");
  expect(await ready()).toMatchObject({ sessions: 1 });
  const request = vi.spyOn(OnDemandWorker.prototype, "request").mockRejectedValue(new Error("broken"));
  writeSession("second");
  expect(service.read(workspace, scope)).toMatchObject({ refreshing: true, sessions: 1 });
  await new Promise(resolve => setImmediate(resolve));
  expect(service.read(workspace, scope)).toMatchObject({ state: "ready", sessions: 1, error: "Pending count unavailable" });
  for (let attempt = 0; attempt < 20; attempt++) service.read(workspace, scope);
  expect(request).toHaveBeenCalledTimes(1);
  service.forget(workspace.id);
  service.read(workspace, scope);
  await new Promise(resolve => setImmediate(resolve));
  expect(service.read(workspace, scope)).toEqual({ state: "failed", sessions: null, commits: null, error: "Pending count unavailable" });
});

it("keeps state, health and achievements responsive during a twenty-second pending calculation", async () => {
  const marker = join(root, "worker-started");
  const workerUrl = new URL("data:text/javascript," + encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    import { writeFileSync } from 'node:fs';
    parentPort.on('message', message => {
      if(message.type==='close'){parentPort.close();return;}
      writeFileSync(${JSON.stringify(marker)}, 'started');
      const started = performance.now();
      while(performance.now()-started < 20000) {}
      parentPort.postMessage({id:message.id,result:{revision:${pendingRevision(store.db)},value:{state:'ready',sessions:0,commits:0},sessions:[]}});
    });
  `));
  const app = await startLocalServer({ directory: store.directory, pendingWorkerUrl: workerUrl });
  const api = async (path: string) => {
    const started = performance.now();
    const response = await fetch(app.origin + path, { headers: { "x-adit-local": "1" }, signal: AbortSignal.timeout(1500) });
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(performance.now() - started).toBeLessThan(1500);
    return data;
  };
  try {
    expect((await api("/api/local/state")).workspaces[0].cloudSync.pending).toEqual({ state: "computing", sessions: null, commits: null });
    await expect.poll(() => existsSync(marker)).toBe(true);
    for (let attempt = 0; attempt < 3; attempt++) {
      const [state] = await Promise.all([
        api("/api/local/state"), api("/health"), api(`/api/local/achievements?workspaceId=${workspace.id}`),
      ]);
      expect(state.workspaces[0].cloudSync.pending.state).toBe("computing");
    }
    await expect.poll(async () => (await api("/api/local/state")).workspaces[0].cloudSync.pending.state,
      { timeout: 25000, interval: 250 }).toBe("ready");
  } finally { await app.close(); }
}, 30000);
