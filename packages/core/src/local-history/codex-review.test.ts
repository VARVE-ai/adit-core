import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalHistory } from "./archive.js";
import { parseCodex } from "./codex.js";
import { readCodexSession, refreshCodexSources } from "./codex-file.js";
import { StructuredHistory } from "./structured-store.js";
import { SourceCheckpoints, sourceStamp } from "./source-checkpoints.js";
import { LocalStore } from "../local-state.js";
import { LocalAnalytics } from "./analytics.js";
import { LocalSessionBrowser } from "./session-browser.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const source = { subagent: { other: "guardian" } };
const prompt = "The following is the Codex agent history whose request action you are assessing: >>> TRANSCRIPT";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adit-codex-review-"));
  const db = new Database(":memory:"), history = new LocalHistory(db);
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, history, sources: [{ id: "codex", paths: [root] }] };
}
function transcript(root: string, id: string, nativeSource: unknown = "cli") {
  return [
    { type: "session_meta", payload: { id, cwd: root, source: nativeSource } },
    { type: "turn_context", payload: { model: "codex-auto-review" } },
    { type: "response_item", timestamp: "2026-10-09T06:18:02Z", payload: { type: "message", role: "user", content: prompt } },
    { type: "response_item", timestamp: "2026-10-09T06:18:12Z", payload: { type: "message", role: "assistant", content: "answer" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
}
function legacy(f: ReturnType<typeof fixture>, id: string, nativeSource: unknown = "cli") {
  const path = join(f.root, `rollout-${id}.jsonl`), text = transcript(f.root, id, nativeSource);
  writeFileSync(path, text);
  const session = parseCodex(text);
  delete session.metadata!.nativeSourceVersion;
  delete session.metadata!.nativeSource;
  new StructuredHistory(f.db).write(session);
  const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  f.db.prepare("INSERT INTO adit_history_sources VALUES (?,?,?,?,8)").run("codex", `${key}#${id}`, id, "legacy");
  new SourceCheckpoints(f.db).save("codex", key, JSON.stringify([resolve(f.root), [f.root]]), 8, [[path, sourceStamp(path)]], [["codex", id]]);
  return { path, text };
}

it.each(["codex", "traex", "augure-code"])("skips %s review bodies before parsing and does not classify by model or prompt", async provider => {
  const f = fixture(), path = join(f.root, "rollout-review.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "review", cwd: f.root, source } }) + "\n{invalid body}\n");
  expect(await readCodexSession(path, provider, f.root)).toEqual([]);
  writeFileSync(path, transcript(f.root, "real"));
  expect(await readCodexSession(path, provider, f.root)).toMatchObject([{ id: "real", provider, messages: [{ content: prompt }, { content: "answer" }] }]);
  writeFileSync(path, transcript(f.root, "child", { subagent: { thread_spawn: { parent_thread_id: "parent" } } }));
  expect(await readCodexSession(path, provider, f.root)).toMatchObject([{ id: "child", parentId: "parent", relationship: "subagent" }]);
});

it("invalidates old discovery metadata and excludes reviews from progress and incremental collection", async () => {
  const f = fixture(), path = join(f.root, "rollout-review.jsonl");
  writeFileSync(path, transcript(f.root, "review", source));
  await f.history.scan(f.root, f.sources, { preview: true });
  f.db.prepare("UPDATE adit_history_discovery_cache SET version=1,metadata_json=?")
    .run(JSON.stringify({ sessions: [{ id: "review", cwd: f.root }] }));
  expect(await f.history.scan(f.root, f.sources, { preview: true })).toMatchObject({ counts: {}, errors: [], pending: {}, cached: 0 });
  expect(await f.history.scan(f.root, f.sources, { preview: true })).toMatchObject({ counts: {}, cached: 1 });
  expect(await f.history.scan(f.root, f.sources, { sourceProgress: () => {} })).toMatchObject({ counts: {}, errors: [], updated: 0 });
  expect(f.db.prepare("SELECT sessions_json FROM adit_history_file_checkpoints").get()).toEqual({ sessions_json: "[]" });
  expect(await f.history.scan(f.root, f.sources)).toMatchObject({ counts: {}, errors: [], updated: 0 });
  expect(f.history.session("codex", "review")).toBeUndefined();
});

it("removes proven legacy reviews at startup, including usage, while keeping native files and real session checkpoints", async () => {
  const f = fixture(), review = legacy(f, "review", source);
  legacy(f, "real");
  f.db.prepare("INSERT INTO adit_history_text_edits VALUES ('codex','real','message:0',0,'edited question',1)").run();
  const checkpoint = f.db.prepare("SELECT * FROM adit_history_file_checkpoints WHERE sessions_json LIKE '%real%'").get();
  const real = f.db.prepare("SELECT * FROM adit_history_messages WHERE session_id='real'").all();
  expect(f.db.prepare("SELECT count(*) n FROM adit_history_usage_entries").get()).toEqual({ n: 2 });
  const upgraded = new LocalHistory(f.db);
  expect(upgraded.counts(f.root)).toEqual({ codex: 1 });
  expect(upgraded.session("codex", "review")).toBeUndefined();
  for (const table of ["messages", "turns", "sources", "usage_entries", "usage_observations"])
    expect(f.db.prepare(`SELECT count(*) n FROM adit_history_${table} WHERE session_id='review'`).get()).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT * FROM adit_history_messages WHERE session_id='real'").all()).toEqual(real);
  expect(f.db.prepare("SELECT count(*) n FROM adit_history_text_edits WHERE session_id='real'").get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT * FROM adit_history_file_checkpoints WHERE sessions_json LIKE '%real%'").get()).toEqual(checkpoint);
  expect(refreshCodexSources(f.db)).toBe(0);
  // The collection parser upgrade is separate from the header-only review cleanup.
  expect(await upgraded.scan(f.root, f.sources)).toMatchObject({ errors: [], updated: 1, counts: { codex: 1 } });
  expect(await upgraded.scan(f.root, f.sources)).toMatchObject({ errors: [], updated: 0, counts: { codex: 1 } });
  expect(readFileSync(review.path, "utf8")).toBe(review.text);
  expect(f.db.pragma("foreign_key_check")).toEqual([]);
});

it.each(["missing", "wrong identity", "malformed", "normal source"])("retains archived sessions when native proof is %s", kind => {
  const f = fixture(), entry = legacy(f, "review", source);
  if (kind === "missing") rmSync(entry.path);
  if (kind === "wrong identity") writeFileSync(entry.path, transcript(f.root, "different", source));
  if (kind === "malformed") writeFileSync(entry.path, "{bad header}\n");
  if (kind === "normal source") writeFileSync(entry.path, transcript(f.root, "review"));
  expect(refreshCodexSources(f.db)).toBe(0);
  expect(f.history.session("codex", "review")).toBeDefined();
});

it("invalidates only derived commit matches referencing a removed reviewer", () => {
  const f = fixture(); legacy(f, "review", source); legacy(f, "real");
  f.db.exec(`INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at,commit_count,completed_count)
    VALUES ('run','workspace',1,'fixture','done',1,2,2);
    INSERT INTO adit_attribution_commits(run_id,repository,sha,submit_provider,submit_session_id,eligible_lines,excluded_lines,certain_lines,likely_lines,possible_lines,moved_lines,unknown_lines)
    VALUES ('run','repo','bad','codex','review',0,0,0,0,0,0,0),('run','repo','good','codex','real',0,0,0,0,0,0,0);`);
  expect(refreshCodexSources(f.db)).toBe(1);
  expect(f.db.prepare("SELECT sha FROM adit_attribution_commits").all()).toEqual([{ sha: "good" }]);
  expect(f.db.prepare("SELECT commit_count,completed_count FROM adit_attribution_runs").get()).toEqual({ commit_count: 1, completed_count: 1 });
});

it("removes reviews from browsing, search and cached overview totals", () => {
  const f = fixture(), store = new LocalStore(join(f.root, "state"));
  cleanup.push(() => store.close());
  const history = new LocalHistory(store.db), shared = { ...f, db: store.db, history };
  const w = { id: "workspace", path: f.root, providers: ["codex"], repositories: [] } as any;
  legacy(shared, "review", source); legacy(shared, "real");
  const analytics = new LocalAnalytics(store.db), browser = new LocalSessionBrowser(store.db, analytics.prices);
  const before = analytics.overview(w);
  expect(browser.list(w).total).toBe(2);
  new LocalHistory(store.db);
  expect(browser.list(w).total).toBe(1);
  expect(browser.list(w, { query: prompt }).total).toBe(1);
  const after = analytics.overview(w);
  expect(after).not.toEqual(before);
  expect(after.usage.totals.total_tokens).toBe(120);
});
