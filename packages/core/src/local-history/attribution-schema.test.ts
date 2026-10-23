import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { ATTRIBUTION_RESULT_TABLES, createAttributionSchema } from "./attribution-schema.js";

it("retires line storage and invalidates old analysis without deleting source history; initialization is idempotent", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys=ON");
    createAttributionSchema(db);
    db.exec(`
      CREATE TABLE adit_history_sessions(id TEXT PRIMARY KEY);
      INSERT INTO adit_history_sessions VALUES ('original');
      CREATE TABLE adit_local_commits(sha TEXT PRIMARY KEY);
      INSERT INTO adit_local_commits VALUES ('commit');
      INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at)
        VALUES ('old','workspace',4,'x','done',1);
      INSERT INTO adit_attribution_commits VALUES ('old','repo','sha',NULL,NULL,NULL,NULL,NULL,NULL,1,0,1,0,0,0,0);
      CREATE TABLE adit_attribution_lines(id TEXT PRIMARY KEY,run_id TEXT REFERENCES adit_attribution_runs(id) ON DELETE CASCADE);
      CREATE TABLE adit_attribution_candidates(line_id TEXT REFERENCES adit_attribution_lines(id) ON DELETE CASCADE);
      CREATE TABLE adit_attribution_evidence(id TEXT PRIMARY KEY,run_id TEXT REFERENCES adit_attribution_runs(id) ON DELETE CASCADE);
      INSERT INTO adit_attribution_lines VALUES ('line','old');
      INSERT INTO adit_attribution_candidates VALUES ('line');
      INSERT INTO adit_attribution_evidence VALUES ('evidence','old');
    `);
    createAttributionSchema(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('adit_attribution_lines','adit_attribution_candidates','adit_attribution_evidence')").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM adit_attribution_runs").all()).toEqual([]);
    for (const table of ATTRIBUTION_RESULT_TABLES) expect(db.prepare(`SELECT * FROM adit_attribution_${table}`).all()).toEqual([]);
    expect(db.prepare("SELECT * FROM adit_history_sessions").all()).toEqual([{ id: "original" }]);
    expect(db.prepare("SELECT * FROM adit_local_commits").all()).toEqual([{ sha: "commit" }]);
    db.exec(`INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES ('new','workspace',4,'x','done',2);
      INSERT INTO adit_attribution_writers VALUES ('new','repo','sha','codex','original','a.ts',100,20,3)`);
    const changes = db.prepare("SELECT total_changes() n").get();
    createAttributionSchema(db);
    expect(db.prepare("SELECT total_changes() n").get()).toEqual(changes);
    expect(db.prepare("SELECT certain_lines FROM adit_attribution_writers").get()).toEqual({ certain_lines: 100 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});
