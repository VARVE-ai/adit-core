import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalStore } from "@varveai/adit-core";
import { createHistorySchema } from "../../../core/src/local-history/schema.js";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { historyBlockDataSql } from "../../../core/src/local-history/block-data.js";
import { createMaintenanceSchema, maintenanceTasks, runMaintenanceBatch, type MaintenanceProgress, type MaintenanceTask } from "./maintenance-tasks.js";
import { MaintenanceService } from "./maintenance-service.js";
import { createCloudSyncSchema, type CloudBaseline } from "./cloud-projection.js";
import { cloudPending } from "./cloud-pending.js";
import { OnDemandWorker } from "./on-demand-worker.js";
import { createCloudPendingSchema, pendingRevision } from "./cloud-pending-schema.js";
import { startLocalServer } from "./server.js";

const fixtures: { root: string; store: LocalStore }[] = [];
const services: { close(): Promise<void> }[] = [];
const task = maintenanceTasks[0];
const workerUrl = process.env.ADIT_TEST_MAINTENANCE_WORKER
  ? pathToFileURL(process.env.ADIT_TEST_MAINTENANCE_WORKER)
  : new URL("../../dist/local/maintenance-worker.js", import.meta.url);

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const { root, store } of fixtures.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(count = 300) {
  const root = mkdtempSync(join(tmpdir(), "adit-maintenance-"));
  const store = new LocalStore(join(root, "data"));
  fixtures.push({ root, store });
  store.saveSchedule({ ...store.schedule(), enabled: false });
  createHistorySchema(store.db);
  createCloudSyncSchema(store);
  createCloudPendingSchema(store.db);
  createMaintenanceSchema(store.db);
  const history = new StructuredHistory(store.db);
  history.write({ provider: "claude", id: "session", cwd: root, messages: Array.from({ length: count }, (_, index) => ({
    key: `message-${index}`, role: index % 2 ? "assistant" : "user", content: { type: "text", text: `content-${index}` }, raw: {},
  })) });
  store.db.exec(`UPDATE adit_history_blocks AS b SET data_json=(SELECT content_json FROM adit_history_messages WHERE id=b.message_id)`);
  return { root, store, history };
}

function resolved(database: Database.Database) {
  return database.prepare(`SELECT b.id,b.message_id,b.block_index,b.kind,b.text_content,${historyBlockDataSql()} AS data_json
    FROM adit_history_blocks b JOIN adit_history_messages m ON m.id=b.message_id ORDER BY b.rowid`).all();
}

function complete(database: Database.Database, maintenanceTask: MaintenanceTask = task): MaintenanceProgress {
  for (let batch = 0; batch < 1000; batch++) {
    const result = runMaintenanceBatch(database, maintenanceTask);
    if (result.progress?.status === "done") return result.progress;
  }
  throw new Error("Maintenance did not finish");
}

function legacyRawFixture(count = 300) {
  const state = fixture(count);
  const content = "原始正文 中文 😀 ".repeat(40);
  state.store.db.prepare("UPDATE adit_history_messages SET content_json=?,raw_json=?,raw_content_paths_json=NULL")
    .run(JSON.stringify(content), JSON.stringify({ payload: { type: "message", content, phase: "final" }, unknown: { retained: true } }));
  return state;
}

it("migrates raw duplicates in resumable batches without changing history, pending state or other business tables", () => {
  const { root, store, history } = legacyRawFixture();
  const before = history.read("claude", "session");
  const tables = ["adit_history_sessions", "adit_history_message_digests", "adit_history_blocks", "adit_history_tool_calls",
    "adit_history_tool_results", "adit_history_edit_evidence", "adit_history_usage_entries", "adit_history_usage_observations"];
  const snapshots = tables.map(table => store.db.prepare(`SELECT * FROM ${table}`).all());
  const workspace = store.saveWorkspace({ path: root, providers: ["claude"], repositories: [] });
  const baseline: CloudBaseline = { schemaVersion: 1, accountId: "account", before: null, repositories: [], sessions: [], nextCursor: null };
  store.db.exec(`INSERT INTO adit_local_cloud_sessions(scope,provider,native_id,cloud_id,revision,sequence_base)
    SELECT 'scope',provider,id,'cloud-session',transcript_revision,0 FROM adit_history_sessions`);
  store.db.prepare("INSERT INTO adit_local_cloud_receipts VALUES (?,?,?,?)").run("scope", "event", "confirmed", 123);
  const pending = cloudPending(store, workspace, "scope", baseline), revision = pendingRevision(store.db);
  const rawTask = maintenanceTasks[1];
  const first = runMaintenanceBatch(store.db, rawTask).progress!;
  expect(first.status).toBe("running");
  expect(first.scanned).toBeLessThanOrEqual(128);
  const resumed = new Database(store.dbPath);
  try { expect(complete(resumed, rawTask)).toMatchObject({ cleared: 300, scanned: 300, skipped: 0 }); }
  finally { resumed.close(); }
  expect(history.read("claude", "session")).toEqual(before);
  expect(tables.map(table => store.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(snapshots);
  expect(pendingRevision(store.db)).toBe(revision);
  expect(cloudPending(store, workspace, "scope", baseline)).toEqual(pending);
  expect(store.db.prepare("SELECT * FROM adit_local_cloud_receipts").all()).toEqual([{ scope: "scope", kind: "event", id: "confirmed", confirmed_at: 123 }]);
  expect(runMaintenanceBatch(store.db, rawTask).progress).toMatchObject({ status: "done", cleared: 300 });
});

it("retains unique, malformed and oversized raw data and rolls back both data and progress on failure", () => {
  const { store } = legacyRawFixture(6);
  const rows = store.db.prepare("SELECT id FROM adit_history_messages ORDER BY rowid").all() as { id: string }[];
  store.db.prepare("UPDATE adit_history_messages SET raw_json=? WHERE id=?").run("malformed", rows[0].id);
  store.db.prepare("UPDATE adit_history_messages SET content_json=? WHERE id=?").run('"edited"', rows[1].id);
  store.db.prepare("UPDATE adit_history_messages SET content_json=NULL WHERE id=?").run(rows[2].id);
  const huge = "large".repeat(2 * 1024 * 1024);
  store.db.prepare("UPDATE adit_history_messages SET raw_json=?,content_json=? WHERE id=?")
    .run(JSON.stringify({ content: huge }), JSON.stringify(huge), rows[3].id);
  store.db.prepare("UPDATE adit_history_messages SET content_json='invalid' WHERE id=?").run(rows[4].id);
  const before = store.db.prepare("SELECT * FROM adit_history_messages ORDER BY rowid").all();
  store.db.exec(`CREATE TRIGGER reject_raw BEFORE UPDATE OF raw_json ON adit_history_messages
    WHEN NEW.raw_content_paths_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'raw cleanup failure'); END;`);
  expect(() => complete(store.db, maintenanceTasks[1])).toThrow("raw cleanup failure");
  expect(store.db.prepare("SELECT * FROM adit_history_messages ORDER BY rowid").all()).toEqual(before);
  store.db.exec("DROP TRIGGER reject_raw");
  expect(complete(store.db, maintenanceTasks[1])).toMatchObject({ scanned: 6, cleared: 1, skipped: 5 });
  expect(store.db.prepare("SELECT * FROM adit_history_messages ORDER BY rowid LIMIT 5").all()).toEqual(before.slice(0, 5));
});

it("lets active jobs run first and rechecks raw content after edits between batches", async () => {
  const { store, history } = legacyRawFixture();
  const rawTask = maintenanceTasks[1];
  store.job({ id: "collect", kind: "collection", status: "running" });
  expect(runMaintenanceBatch(store.db, rawTask)).toEqual({ paused: true });
  store.job({ id: "collect", kind: "collection", status: "done" });
  const first = runMaintenanceBatch(store.db, rawTask).progress!;
  const next = store.db.prepare("SELECT id FROM adit_history_messages WHERE rowid>? ORDER BY rowid LIMIT 1").get(first.cursor) as { id: string };
  store.db.prepare("UPDATE adit_history_messages SET content_json=? WHERE id=?").run('"edited before cleanup"', next.id);
  const before = history.read("claude", "session");
  const worker = new OnDemandWorker(workerUrl, { path: store.dbPath }, () => new Error("Raw maintenance failed"));
  services.push(worker);
  let progress: MaintenanceProgress | undefined;
  for (let batch = 0; batch < 1000 && progress?.status !== "done"; batch++)
    progress = (await worker.request<{ progress: MaintenanceProgress }>({ task: rawTask })).progress;
  expect(progress).toMatchObject({ status: "done", cleared: 299, skipped: 1 });
  expect(history.read("claude", "session")).toEqual(before);
});

it("resumes bounded batches without changing content, business revisions, digests or receipts", () => {
  const { root, store } = fixture();
  const content = resolved(store.db);
  const sessions = store.db.prepare("SELECT * FROM adit_history_sessions").all();
  const digests = store.db.prepare("SELECT * FROM adit_history_message_digests").all();
  store.db.prepare("INSERT INTO adit_local_cloud_receipts VALUES (?,?,?,?)").run("scope", "event", "confirmed", 123);
  const workspace = store.saveWorkspace({ path: root, providers: ["claude"], repositories: [] });
  const baseline: CloudBaseline = { schemaVersion: 1, accountId: "account", before: null, repositories: [], sessions: [], nextCursor: null };
  store.db.exec(`INSERT INTO adit_local_cloud_sessions(scope,provider,native_id,cloud_id,revision,sequence_base)
    SELECT 'scope',provider,id,'cloud-session',transcript_revision,0 FROM adit_history_sessions`);
  expect(cloudPending(store, workspace, "scope", baseline)).toEqual({ state: "ready", sessions: 0, commits: 0 });
  const revision = pendingRevision(store.db);
  const first = runMaintenanceBatch(store.db, task).progress!;
  expect(first.status).toBe("running");
  expect(first.scanned).toBeGreaterThan(0);
  expect(first.scanned).toBeLessThanOrEqual(128);
  const resumed = new Database(store.dbPath);
  let result: MaintenanceProgress;
  try { result = complete(resumed); } finally { resumed.close(); }
  expect(result).toMatchObject({ cleared: 300, skipped: 0, scanned: 300 });
  expect(result.bytes_removed).toBeGreaterThan(0);
  expect(resolved(store.db)).toEqual(content);
  expect(store.db.prepare("SELECT * FROM adit_history_sessions").all()).toEqual(sessions);
  expect(store.db.prepare("SELECT * FROM adit_history_message_digests").all()).toEqual(digests);
  expect(store.db.prepare("SELECT * FROM adit_local_cloud_receipts").all()).toEqual([{ scope: "scope", kind: "event", id: "confirmed", confirmed_at: 123 }]);
  expect(pendingRevision(store.db)).toBe(revision);
  expect(cloudPending(store, workspace, "scope", baseline)).toEqual({ state: "ready", sessions: 0, commits: 0 });
  expect(runMaintenanceBatch(store.db, task).progress).toEqual(result);
});

it("retains mismatched, malformed, missing and oversized originals instead of deleting unique content", () => {
  const { store } = fixture(6);
  const blocks = store.db.prepare("SELECT id,message_id FROM adit_history_blocks ORDER BY rowid").all() as { id: string; message_id: string }[];
  store.db.prepare("UPDATE adit_history_blocks SET data_json=? WHERE id=?").run('{"unique":true}', blocks[0].id);
  store.db.prepare("UPDATE adit_history_messages SET content_json=? WHERE id=?").run("broken", blocks[1].message_id);
  store.db.prepare("UPDATE adit_history_messages SET content_json=NULL WHERE id=?").run(blocks[2].message_id);
  store.db.prepare("UPDATE adit_history_blocks SET block_index=7 WHERE id=?").run(blocks[3].id);
  const huge = JSON.stringify("large".repeat(2 * 1024 * 1024));
  store.db.prepare("UPDATE adit_history_messages SET content_json=? WHERE id=?").run(huge, blocks[4].message_id);
  store.db.prepare("UPDATE adit_history_blocks SET data_json=? WHERE id=?").run(huge, blocks[4].id);
  const before = resolved(store.db);
  expect(complete(store.db)).toMatchObject({ scanned: 6, cleared: 1, skipped: 5 });
  expect(resolved(store.db)).toEqual(before);
});

it("commits each batch atomically and resumes after failure without losing legacy records", () => {
  const { store } = fixture(3);
  const before = resolved(store.db);
  store.db.exec(`CREATE TRIGGER reject_cleanup BEFORE UPDATE OF data_json ON adit_history_blocks
    WHEN NEW.data_json IS NULL BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
  expect(() => runMaintenanceBatch(store.db, task)).toThrow("fixture failure");
  expect(store.db.prepare("SELECT * FROM adit_local_maintenance").all()).toEqual([]);
  expect(resolved(store.db)).toEqual(before);
  store.db.exec("DROP TRIGGER reject_cleanup");
  store.db.prepare("INSERT INTO adit_local_maintenance VALUES (?,'failed',0,-1,0,0,0,0,0,'previous failure')").run(task);
  expect(complete(store.db)).toMatchObject({ cleared: 3, error: null });
  expect(resolved(store.db)).toEqual(before);
});

it("yields to collection and sync, and checks current values after concurrent edits between batches", () => {
  const { store } = fixture();
  store.job({ id: "sync", kind: "cloud-sync", status: "running" });
  expect(runMaintenanceBatch(store.db, task)).toEqual({ paused: true });
  store.job({ id: "sync", kind: "cloud-sync", status: "done" });
  const first = runMaintenanceBatch(store.db, task).progress!;
  const next = store.db.prepare("SELECT message_id FROM adit_history_blocks WHERE rowid>? ORDER BY rowid LIMIT 1").get(first.cursor) as { message_id: string };
  store.db.prepare("UPDATE adit_history_messages SET content_json=? WHERE id=?").run('"concurrent edit"', next.message_id);
  const before = resolved(store.db);
  expect(complete(store.db)).toMatchObject({ cleared: 299, skipped: 1 });
  expect(resolved(store.db)).toEqual(before);
  expect(store.db.prepare("SELECT content_json FROM adit_history_messages WHERE id=?").get(next.message_id)).toEqual({ content_json: '"concurrent edit"' });
});

it("runs in an on-demand worker, retires after completion and does not repeat a finished task", async () => {
  const { root, store } = fixture();
  const starts = join(root, "starts"), exited = join(root, "exited"), wrapper = join(root, "worker.mjs");
  writeFileSync(wrapper, `import ${JSON.stringify(workerUrl.href)};
    import {appendFileSync,writeFileSync} from 'node:fs';
    appendFileSync(${JSON.stringify(starts)},'started');
    process.on('exit',()=>writeFileSync(${JSON.stringify(exited)},'done'));`);
  const service = new MaintenanceService(store, pathToFileURL(wrapper));
  services.push(service);
  service.start(0);
  service.start(0);
  await expect.poll(() => {
    expect(service.status()[0]?.error).toBeFalsy();
    return service.status()[0]?.status;
  }, { timeout: 10000 }).toBe("done");
  expect(service.status()[0]).toMatchObject({ cleared: 300, skipped: 0 });
  await expect.poll(() => existsSync(exited), { timeout: 5000 }).toBe(true);
  expect(readFileSync(starts, "utf8")).toBe("started");
  const restarted = new MaintenanceService(store, pathToFileURL(wrapper));
  services.push(restarted);
  restarted.start(0);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(readFileSync(starts, "utf8")).toBe("started");
}, 15000);

it("backs off on a competing writer without failing or clearing progress", async () => {
  const { store } = fixture(3);
  const worker = new OnDemandWorker(workerUrl, { path: store.dbPath }, () => new Error("Maintenance failed"));
  services.push(worker);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    expect(await worker.request({ task })).toEqual({ paused: true });
    expect(store.db.prepare("SELECT count(*) count FROM adit_history_blocks WHERE data_json IS NOT NULL").get()).toEqual({ count: 3 });
  } finally { store.db.exec("ROLLBACK"); }
  expect(await worker.request({ task })).toMatchObject({ progress: { status: "done", cleared: 3 } });
});

it("keeps health and state responsive while a maintenance worker is busy", async () => {
  const { root, store } = fixture(2);
  const started = join(root, "started"), wrapper = join(root, "busy-worker.mjs");
  writeFileSync(wrapper, `import {parentPort} from 'node:worker_threads';
    import {writeFileSync} from 'node:fs';
    parentPort.on('message',({type,id})=>{
      if(type==='close'){parentPort.close();return;}
      writeFileSync(${JSON.stringify(started)},'busy');
      const deadline=Date.now()+1500;while(Date.now()<deadline){}
      parentPort.postMessage({id,result:{paused:true}});
    });`);
  const app = await startLocalServer({ directory: store.directory, maintenanceWorkerUrl: pathToFileURL(wrapper) });
  services.push(app);
  await expect.poll(() => existsSync(started), { timeout: 10000 }).toBe(true);
  for (const endpoint of ["/health", "/api/local/state", "/api/local/maintenance"]) {
    const start = performance.now();
    const response = await fetch(app.origin + endpoint, { headers: { "x-adit-local": "1" }, signal: AbortSignal.timeout(1200) });
    expect(response.ok).toBe(true);
    expect(performance.now() - start).toBeLessThan(1200);
  }
}, 15000);
