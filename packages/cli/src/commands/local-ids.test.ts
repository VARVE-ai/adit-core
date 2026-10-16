import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLocalId } from "./local-ids.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE env_snapshots (id TEXT PRIMARY KEY);
  `);
  const insert = db.prepare("INSERT INTO events (id, deleted_at) VALUES (?, ?)");
  insert.run("01M3RRP1WFWZE89SS7760G2F5A", null);
  insert.run("01M3RRNYVY00PF1JWNYQJ66T0M", null);
  insert.run("01M3RRNYWF3YGWWKWMEDFA844Q", null);
  insert.run("01M3AAAAAA0000000000000000", "2026-09-30T00:00:00.000Z");
  db.prepare("INSERT INTO env_snapshots (id) VALUES (?)").run("01M3RRNYWF3YGWWKWMEDFA844Q");
});

afterEach(() => db.close());

describe("resolveLocalId", () => {
  it("matches a full ID exactly", () => {
    expect(resolveLocalId(db, "events", "01M3RRP1WFWZE89SS7760G2F5A")).toEqual({ kind: "found", id: "01M3RRP1WFWZE89SS7760G2F5A" });
  });

  it("expands the 10-character prefix the CLI prints, ignoring case", () => {
    expect(resolveLocalId(db, "events", "01M3RRP1WF")).toEqual({ kind: "found", id: "01M3RRP1WFWZE89SS7760G2F5A" });
    expect(resolveLocalId(db, "events", "01m3rrp1wf")).toEqual({ kind: "found", id: "01M3RRP1WFWZE89SS7760G2F5A" });
    expect(resolveLocalId(db, "env_snapshots", "01M3RRNYWF")).toEqual({ kind: "found", id: "01M3RRNYWF3YGWWKWMEDFA844Q" });
  });

  it("reports an ambiguous prefix with its candidates", () => {
    const lookup = resolveLocalId(db, "events", "01M3RRNY");
    expect(lookup).toEqual({ kind: "ambiguous", candidates: ["01M3RRNYWF3YGWWKWMEDFA844Q", "01M3RRNYVY00PF1JWNYQJ66T0M"] });
  });

  it("ignores deleted events, very short prefixes and unknown IDs", () => {
    expect(resolveLocalId(db, "events", "01M3AAAAAA")).toEqual({ kind: "missing" });
    expect(resolveLocalId(db, "events", "01M")).toEqual({ kind: "missing" });
    expect(resolveLocalId(db, "events", "bogus")).toEqual({ kind: "missing" });
    expect(resolveLocalId(db, "sessions", "01M3RRP1WF")).toEqual({ kind: "missing" });
  });
});
