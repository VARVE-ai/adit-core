import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeletionCheckpoint } from "./deletion-checkpoint.js";

const resources: { root: string; db: Database.Database; maintenance: DeletionCheckpoint }[] = [];
afterEach(async () => {
  for (const { root, db, maintenance } of resources.splice(0)) {
    await maintenance.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});
function fixture(flush?: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "adit-delete-checkpoint-")), path = join(root, "test.sqlite");
  const db = new Database(path);
  db.pragma("journal_mode=WAL"); db.pragma("wal_autocheckpoint=1000");
  db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO records VALUES(1,'keep'),(2,'delete')");
  const maintenance = new DeletionCheckpoint(db, flush);
  resources.push({ root, db, maintenance }); return { db, maintenance, path };
}
it("commits deletion before waiting for maintenance and restores automatic checkpoints", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const { db, maintenance } = fixture(() => pending);
  maintenance.run(() => db.transaction(() => {
    expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(0);
    db.prepare("DELETE FROM records WHERE id=2").run();
  }).immediate());
  expect(db.prepare("SELECT id FROM records").all()).toEqual([{ id: 1 }]);
  expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
  finish(); await maintenance.close();
});
it("rolls back failed deletion and preserves journal protection", () => {
  let calls = 0;
  const { db, maintenance } = fixture(async () => { calls++; });
  expect(() => maintenance.run(() => db.transaction(() => {
    db.exec("DELETE FROM records"); throw new Error("rollback");
  }).immediate())).toThrow("rollback");
  expect(db.prepare("SELECT count(*) n FROM records").get()).toEqual({ n: 2 });
  expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
  expect(calls).toBe(0);
});
it("checkpoints in a worker and releases the WAL file when no reader needs it", async () => {
  const { db, maintenance, path } = fixture();
  db.prepare("UPDATE records SET body=? WHERE id=2").run("x".repeat(300000));
  maintenance.run(() => db.transaction(() => db.prepare("DELETE FROM records WHERE id=2").run()).immediate());
  await maintenance.close();
  expect(statSync(path + "-wal").size).toBe(0);
  expect(db.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, body: "keep" }]);
  expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
});
it("retains WAL pages needed by a reader and leaves its snapshot valid", async () => {
  const { db, maintenance, path } = fixture();
  const reader = new Database(path, { readonly: true });
  try {
    reader.exec("BEGIN");
    expect(reader.prepare("SELECT count(*) n FROM records").get()).toEqual({ n: 2 });
    maintenance.run(() => db.transaction(() => db.prepare("DELETE FROM records WHERE id=2").run()).immediate());
    await maintenance.close();
    expect(statSync(path + "-wal").size).toBeGreaterThan(0);
    expect(reader.prepare("SELECT count(*) n FROM records").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT count(*) n FROM records").get()).toEqual({ n: 1 });
    reader.exec("ROLLBACK");
  } finally { reader.close(); }
});
