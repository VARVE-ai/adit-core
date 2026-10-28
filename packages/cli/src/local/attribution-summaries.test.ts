import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { createAttributionSchema } from "../../../core/src/local-history/attribution-schema.js";
import { saveAttributionSummaries } from "./attribution-summaries.js";

it("reduces many matched lines to file/session counts while preserving alternative counts and original evidence turns", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys=ON");
    createAttributionSchema(db);
    db.exec("INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES ('run','workspace',4,'x','done',1)");
    const lines = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i), path: i < 900 ? "a.ts" : "b.ts", tier: i < 900 ? "likely" : "possible",
      provider: "claude", session: "representative", evidence: i < 900 ? "first" : "second",
    }));
    const candidates = lines.flatMap(l => [
      { line: l.id, provider: "claude", session: "representative", selected: 1 },
      { line: l.id, provider: "codex", session: "alternative", selected: 0 },
    ]);
    const evidence = new Map([
      ["first", { provider: "claude", sessionId: "original", turnId: "turn-1" }],
      ["second", { provider: "claude", sessionId: "subtask", turnId: null }],
    ]);
    db.transaction(() => saveAttributionSummaries(db, "run", "repo", "sha", lines, candidates, evidence))();
    expect(db.prepare("SELECT file_path,certain_lines,likely_lines,possible_lines FROM adit_attribution_writers ORDER BY file_path").all()).toEqual([
      { file_path: "a.ts", certain_lines: 0, likely_lines: 900, possible_lines: 0 },
      { file_path: "b.ts", certain_lines: 0, likely_lines: 0, possible_lines: 100 },
    ]);
    expect(db.prepare("SELECT writer_session_id,session_id,likely_lines,possible_lines FROM adit_attribution_alternatives").all()).toEqual([
      { writer_session_id: "representative", session_id: "alternative", likely_lines: 900, possible_lines: 100 },
    ]);
    expect(db.prepare("SELECT session_id,turn_id FROM adit_attribution_turns ORDER BY session_id").all()).toEqual([
      { session_id: "original", turn_id: "turn-1" }, { session_id: "subtask", turn_id: "" },
    ]);
    db.prepare("DELETE FROM adit_attribution_runs").run();
    for (const table of ["writers", "alternatives", "turns"]) expect(db.prepare(`SELECT * FROM adit_attribution_${table}`).all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});
