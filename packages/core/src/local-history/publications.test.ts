import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../local-state.js";
import { createHistorySchema } from "./schema.js";
import { StructuredHistory } from "./structured-store.js";
import { LocalAnalytics } from "./analytics.js";
import { LocalSharing } from "./sharing.js";
import { PublicationPrivacy } from "./publication-privacy.js";
import { LocalPrDescriptions } from "./pr-descriptions.js";
import { LocalSessionBrowser } from "./session-browser.js";
import type { PrScope } from "./pr-types.js";
let root: string, store: LocalStore, analytics: LocalAnalytics;
afterEach(async () => { vi.restoreAllMocks(); await analytics?.prices.close(); store?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), "adit-publications-")); store = new LocalStore(join(root, "state")); createHistorySchema(store.db); analytics = new LocalAnalytics(store.db);
  const w = store.saveWorkspace({ path: root, providers: ["claude", "codex"], repositories: [] });
  const history = new StructuredHistory(store.db);
  history.write({ provider: "claude", id: "original-session-12345", cwd: root, messages: [
    { key: "u1", role: "user", content: "Fix C:\\Users\\Alice\\secret.txt using alice@example.org", raw: {}, timestamp: "2026-10-20T00:00:00Z" },
    { key: "a1", role: "assistant", content: [{ type: "thinking", thinking: "private thought" }, { type: "tool_use", id: "call_01234567", name: "Bash", input: { command: "cat /home/alice/private.txt" } }], raw: {}, model: "model-a", usage: { input_tokens: 10, output_tokens: 20 }, timestamp: "2026-10-20T00:00:02Z" },
    { key: "o1", role: "user", content: [{ type: "tool_result", tool_use_id: "call_01234567", content: "PRIVATE OUTPUT" }], raw: {} },
    { key: "memory", role: "assistant", content: [{ type: "tool_use", id: "call_memory123", name: "memory_save", input: { content: "personal memory sentence" } }], raw: {} },
    { key: "a2", role: "assistant", content: "Changed the first file.", raw: {} },
    { key: "u2", role: "user", content: "UNSELECTED TURN", raw: {} },
    { key: "a3", role: "assistant", content: "UNSELECTED ANSWER", raw: {} },
  ] });
  const sharing = new LocalSharing(store.db, analytics.prices);
  return { w, history, sharing };
}
it("shares edited text and omits deleted turns while requiring a fresh review", () => {
  const { w, sharing } = fixture(), browser = new LocalSessionBrowser(store.db, analytics.prices);
  const id = "original-session-12345", old = sharing.create(w, "claude", id);
  const turns = browser.detail(w, "claude", id).turns;
  const edit = browser.editTurn(w, "claude", id, turns[0].id);
  browser.updateTurn(w, "claude", id, edit.turnId, edit.revision, [{ id: edit.blocks[0].id, text: "Reviewed question" }, { id: edit.blocks.at(-1)!.id, text: "Reviewed answer" }]);
  const deletion = browser.editTurn(w, "claude", id, turns[1].id);
  browser.deleteTurn(w, "claude", id, deletion.turnId, deletion.revision);
  expect(() => sharing.beginPublish(w, old.id, old.version, old.digest, "outdated")).toThrow("Content changed");
  const current = sharing.create(w, "claude", id);
  expect(current.snapshot.promptCount).toBe(1);
  expect(current.snapshot.turns[0].prompt).toBe("Reviewed question");
  expect(current.snapshot.turns[0].events.some(e => e.text === "Reviewed answer")).toBe(true);
  expect(JSON.stringify(current.snapshot)).not.toContain("UNSELECTED");
});
it("includes an image-only prompt and its answer in the reviewed share without embedding image bytes",()=>{
 const {w,history,sharing}=fixture();history.write({id:'photo',provider:'codex',cwd:root,messages:[
  {key:'p',role:'user',content:[{type:'input_image',image_url:'data:PRIVATE'}],raw:{}},
  {key:'a',role:'assistant',content:'Image reply',raw:{}},
 ]});
 const draft=sharing.create(w,'codex','photo');expect(draft.snapshot.promptCount).toBe(1);
 expect(draft.snapshot.turns[0].prompt).toBe('[Image]');expect(draft.markdown).toContain('Image reply');expect(draft.markdown).not.toContain('PRIVATE');
});
it("excludes native compaction and interruption controls while retaining ordinary summary prose",()=>{
 const {w,history,sharing}=fixture();history.write({id:'context',provider:'codex',cwd:root,messages:[
  {key:'p',role:'user',content:'Explain summaries',raw:{}},
  {key:'a',role:'assistant',content:'## Task and Scope: a normal user-facing answer',raw:{}},
  {key:'s',role:'assistant',content:'PRIVATE COMPACTION',raw:{metadata:{compaction_output:true}}},
  {key:'u',role:'user',content:'<turn_aborted>PRIVATE INTERRUPTION</turn_aborted>',raw:{}},
 ]});
 const draft=sharing.create(w,'codex','context');expect(draft.snapshot.promptCount).toBe(1);
 expect(draft.markdown).toContain('a normal user-facing answer');expect(draft.markdown).not.toContain('PRIVATE');
});
it("shares both native segments and invalidates review when either segment changes",()=>{
 const {w,sharing,history}=fixture();
 const original={provider:"codex",id:"native",cwd:root,messages:[{key:"p",role:"user",content:"first part",raw:{}}]};
 const page={...original,id:"native_page",parentId:"native",relationship:"continuation" as const,messages:[{key:"p",role:"user",content:"continued part",raw:{}}]};
 history.write(original);history.write(page);
 history.write({...original,id:"unrelated",messages:[{key:"p",role:"user",content:"UNRELATED SESSION",raw:{}}]});
 history.write({...original,provider:"claude",messages:[{key:"p",role:"user",content:"OTHER PROVIDER",raw:{}}]});
 const draft=sharing.create(w,"codex","native");expect(draft.snapshot.promptCount).toBe(2);
 expect(draft.snapshot.turns.map(t=>t.prompt)).toEqual(["first part","continued part"]);
 expect(draft.markdown).not.toContain("UNRELATED SESSION");expect(draft.markdown).not.toContain("OTHER PROVIDER");
 const second=sharing.create(w,"codex","native",{options:{scope:"selected",turnIds:[draft.turns[1].id]}});
 expect(second.snapshot.promptCount).toBe(1);expect(second.snapshot.turns[0].prompt).toBe("continued part");
 history.write({...page,messages:[...page.messages,{key:"p2",role:"user",content:"new question",raw:{}}]});
 expect(()=>sharing.beginPublish(w,draft.id,draft.version,draft.digest,"stale-segments")).toThrow("Content changed");
});
it.each(["create", "update", "pr"])("saves a %s snapshot while collection writes through another connection", kind => {
  const { w, sharing } = fixture(); w.repositories = [root];
  const draft = kind === "update" ? sharing.create(w, "claude", "original-session-12345") : undefined;
  const collector = new Database(store.dbPath);
  collector.pragma("busy_timeout = 20");
  const redact = PublicationPrivacy.prototype.text;
  let collected = false;
  vi.spyOn(PublicationPrivacy.prototype, "text").mockImplementation(function (text, field) {
    if (!collected) {
      collected = true;
      collector.prepare("INSERT INTO adit_local_settings(key,data) VALUES ('concurrent-collection','true')").run();
    }
    return redact.call(this, text, field);
  });
  try {
    if (kind === "pr") {
      const pr = new LocalPrDescriptions(store.db);
      const scope: PrScope = { repository: root, kind: "commits", head: null, base: null, headSha: null, baseSha: null, mergeBase: null, author: "me", digest: "scope", commits: [{ sha: "a".repeat(40), subject: "collected commit", included: true, reason: null }] };
      const result = pr.generate(w, scope, { lines: false });
      expect(pr.read(w, result.id)).toEqual(result);
    } else {
      const result = draft ? sharing.update(w, draft.id, { title: "Updated preview" }) : sharing.create(w, "claude", "original-session-12345");
      expect(sharing.read(w, result.id).snapshot).toEqual(result.snapshot);
      expect(result.snapshot.promptCount).toBe(2);
    }
    expect(collected).toBe(true);
    expect(store.get("concurrent-collection", false)).toBe(true);
  } finally { collector.close(); }
});
it("keeps one source revision during preview and requires review again if collection changes it", () => {
  const { w, sharing } = fixture();
  const collector = new Database(store.dbPath);
  const original = store.db.prepare("SELECT transcript_revision FROM adit_history_sessions WHERE id=?").get("original-session-12345") as { transcript_revision: number };
  const redact = PublicationPrivacy.prototype.text;
  vi.spyOn(PublicationPrivacy.prototype, "text").mockImplementationOnce(function (text, field) {
    collector.prepare("UPDATE adit_history_sessions SET transcript_revision=transcript_revision+1").run();
    return redact.call(this, text, field);
  });
  try {
    const draft = sharing.create(w, "claude", "original-session-12345");
    expect(draft.sourceRevision).toBe(original.transcript_revision);
    expect(() => sharing.beginPublish(w, draft.id, draft.version, draft.digest, "changed-source")).toThrow("Content changed");
    const reviewed = sharing.update(w, draft.id, {});
    expect(reviewed.sourceRevision).toBe(original.transcript_revision + 1);
    expect(sharing.beginPublish(w, reviewed.id, reviewed.version, reviewed.digest, "reviewed-source").status).toBe("publishing");
  } finally { collector.close(); }
});
it.each(["published", "new-version"])("does not overwrite a draft that changed to %s while its preview was calculated", change => {
  const { w, sharing } = fixture(), draft = sharing.create(w, "claude", "original-session-12345");
  const other = new Database(store.dbPath);
  const redact = PublicationPrivacy.prototype.text;
  vi.spyOn(PublicationPrivacy.prototype, "text").mockImplementationOnce(function (text, field) {
    if (change === "published") other.prepare("UPDATE adit_shares SET status='published' WHERE id=?").run(draft.id);
    else {
      const next = { ...(other.prepare("SELECT * FROM adit_share_versions WHERE id=?").get(draft.version) as Record<string, unknown>), id: "concurrent-version" };
      const keys = Object.keys(next);
      other.prepare(`INSERT INTO adit_share_versions (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => next[k]));
      other.prepare("UPDATE adit_shares SET current_version_id=? WHERE id=?").run(next.id, draft.id);
    }
    return redact.call(this, text, field);
  });
  try {
    expect(() => sharing.update(w, draft.id, { title: "Must not be saved" })).toThrow(change === "published" ? "cannot be edited" : "Content changed");
    const saved = sharing.read(w, draft.id);
    expect(saved.snapshot.title).toBe(draft.snapshot.title);
    expect(saved.status).toBe(change === "published" ? "published" : "ready");
    expect(store.db.prepare("SELECT count(*) n FROM adit_share_versions").get()).toEqual({ n: change === "published" ? 1 : 2 });
  } finally { other.close(); }
});
it("exports the complete selected turn, excludes private categories and never exports local identifiers", () => {
  const { w, sharing } = fixture();
  const all = sharing.create(w, "claude", "original-session-12345");
  const second = sharing.update(w, all.id, { title: all.snapshot.title, options: { scope: "selected", turnIds: [all.turns[1].id] } });
  expect(second.snapshot.title).toBe("UNSELECTED TURN");
  const custom = sharing.update(w, all.id, { title: "Custom explanation" });
  expect(sharing.update(w, all.id, { options: { scope: "all" } }).snapshot.title).toBe(custom.snapshot.title);
  const draft = sharing.update(w, all.id, { options: { scope: "selected", turnIds: [all.turns[0].id] } });
  const text = JSON.stringify(draft.snapshot);
  for (const forbidden of ["Alice", "alice@example.org", "call_01234567", "original-session-12345", "PRIVATE OUTPUT", "private thought", "personal memory sentence", "UNSELECTED TURN", "UNSELECTED ANSWER", "costMicrousd"])
    expect(text).not.toContain(forbidden);
  expect(text).toContain("Changed the first file.");
  expect(draft.snapshot.promptCount).toBe(1);
  expect(draft.memoryActions).toBe(1);
  expect(draft.snapshot.turns[0].input).toBe(10);
  expect(sharing.list(w).total).toBe(0);
  const withOutput = sharing.update(w, draft.id, { options: { mode: "normal", outputs: true, thinking: true } });
  expect(JSON.stringify(withOutput.snapshot)).toContain("PRIVATE OUTPUT");
  expect(JSON.stringify(withOutput.snapshot)).toContain("private thought");
});
it("rejects foreign sessions, invalid turn selections and stale publication versions", () => {
  const { w, sharing, history } = fixture();
  history.write({ provider: "claude", id: "foreign", cwd: root + "-outside", messages: [{ key: "u", role: "user", content: "outside", raw: {} }] });
  expect(() => sharing.create(w, "claude", "foreign")).toThrow("Session not found");
  const draft = sharing.create(w, "claude", "original-session-12345");
  expect(() => sharing.update(w, draft.id, { options: { scope: "selected", turnIds: ["foreign"] } })).toThrow("valid prompt");
  const next = sharing.update(w, draft.id, { title: "New title" });
  expect(() => sharing.beginPublish(w, draft.id, draft.version, draft.digest, "request-1")).toThrow("Content changed");
  store.db.prepare("UPDATE adit_history_sessions SET transcript_revision=transcript_revision+1").run();
  expect(() => sharing.beginPublish(w, next.id, next.version, next.digest, "request-1")).toThrow("Content changed");
});
it("skips Codex bootstrap context and derives the title from the first actual prompt", () => {
  const { w, sharing, history } = fixture();
  history.write({ provider: "codex", id: "context", cwd: root, messages: [
    { key: "context", role: "user", content: "<environment_context>PRIVATE BOOTSTRAP</environment_context>", raw: {} },
    { key: "actual", role: "user", content: "\n\nPlease fix the app", raw: {} },
    { key: "reply", role: "assistant", content: "Done", raw: {} },
  ] });
  const draft = sharing.create(w, "codex", "context");
  expect(draft.snapshot.title).toBe("Please fix the app"); expect(draft.snapshot.promptCount).toBe(1);
  expect(JSON.stringify(draft.snapshot)).not.toContain("BOOTSTRAP");
});
it("uses the conversation title across segments and preserves a manually edited share title", () => {
  const { w, sharing, history } = fixture();
  const prompt = '# Files mentioned by the user:\nattachment.png\n\n## My request:\nChange the default to twelve months';
  history.write({ provider: 'codex', id: 'titled', cwd: root, metadata: { title: 'Twelve-month statistics' }, messages: [
    { key: 'p', role: 'user', content: prompt, raw: {} },
  ] });
  history.write({ provider: 'codex', id: 'page', cwd: root, parentId: 'titled', relationship: 'continuation', messages: [
    { key: 'p2', role: 'user', content: 'Follow-up question', raw: {} },
  ] });
  const draft = sharing.create(w, 'codex', 'page');
  expect(draft.snapshot.title).toBe(new LocalSessionBrowser(store.db).detail(w, 'codex', 'page').session.title);
  expect(draft.snapshot.title).toBe('Twelve-month statistics');
  const selected = sharing.update(w, draft.id, { title: draft.snapshot.title, options: { scope: 'selected', turnIds: [draft.turns[1].id], mode: 'focused' } });
  expect(selected.snapshot.title).toBe(draft.snapshot.title);
  expect(selected.snapshot.promptCount).toBe(1);
  sharing.update(w, draft.id, { title: 'My explanation' });
  expect(sharing.update(w, draft.id, { options: { mode: 'normal' } }).snapshot.title).toBe('My explanation');
  history.write({ provider: 'codex', id: 'untitled', cwd: root, messages: [{ key: 'p', role: 'user', content: prompt, raw: {} }] });
  const fallback = sharing.create(w, 'codex', 'untitled');
  expect(fallback.snapshot.title).toBe('Change the default to twelve months');
  expect(fallback.snapshot.turns[0].prompt).toBe(prompt);
});
it.each(['codex', 'claude'])('shares the same focused replies as the %s session view while keeping other switches independent', provider => {
  const { w, sharing, history } = fixture();
  history.write({ provider, id: 'modes', cwd: root, messages: [
    { key: 'p', role: 'user', content: 'First question', raw: {} },
    { key: 'progress', role: 'assistant', content: [{ type: 'text', text: 'Intermediate progress' }], raw: { payload: { phase: 'commentary' } } },
    { key: 'tool', role: 'assistant', content: [{ type: 'tool_use', id: 'command', name: 'Bash', input: { command: 'git status' } }], raw: {} },
    { key: 'output', role: 'tool', content: 'PRIVATE OUTPUT', raw: { tool_call_id: 'command' } },
    { key: 'final', role: 'assistant', finalReply: true, content: [{ type: 'text', text: 'Final answer' }, { type: 'text', text: 'Second paragraph' }], raw: {} },
    { key: 'p2', role: 'user', content: 'Second question', raw: {} },
    { key: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Last reply' }], raw: {} },
  ] });
  const initial = sharing.create(w, provider, 'modes');
  expect(initial.options).toMatchObject({ mode: 'focused', dialogue: true, commands: false, commits: false, outputs: false, thinking: false, cost: false });
  expect(initial.markdown).not.toContain('Intermediate progress');
  expect(initial.snapshot.commandCount).toBe(0);
  expect(initial.snapshot.commitCount).toBe(0);
  expect(initial.snapshot.costMicrousd).toBeUndefined();
  const all = sharing.update(w, initial.id, { options: { mode: 'normal', commands: true, commits: true } });
  expect(all.markdown).toContain('Intermediate progress');
  const focused = sharing.update(w, all.id, { options: { mode: 'focused', commands: false, cost: true } });
  const browsed = new LocalSessionBrowser(store.db).detail(w, provider, 'modes', 'focused');
  expect(focused.snapshot.turns.map(t => t.events.filter(e => e.kind === 'reply').map(e => e.text)))
    .toEqual(browsed.turns.map(t => t.events.filter(e => e.kind === 'reply').map(e => e.text)));
  expect(focused.markdown).not.toContain('Intermediate progress');
  expect(focused.markdown).not.toContain('git status');
  expect(focused.markdown).not.toContain('PRIVATE OUTPUT');
  expect(focused.snapshot.costMicrousd).toBeNull();
  const withCommands = sharing.update(w, all.id, { options: { commands: true, cost: false } });
  expect(withCommands.options.mode).toBe('focused');
  expect(withCommands.snapshot.commandCount).toBe(1);
  expect(withCommands.markdown).toContain('git status');
  expect(withCommands.snapshot.costMicrousd).toBeUndefined();
  expect(sharing.update(w, all.id, { options: { mode: 'normal' } }).markdown).toContain('Intermediate progress');
  expect(() => sharing.update(w, all.id, { options: { mode: 'invalid' as any } })).toThrow('Invalid share mode');
});
it("does not duplicate Codex native tool payloads as replies or leak them when commands are excluded", () => {
  const { w, sharing, history } = fixture();
  history.write({ provider: "codex", id: "tool-payload", cwd: root, messages: [
    { key: "u", role: "user", content: "Check the repository", raw: {} },
    { key: "t", role: "assistant", content: "git status --short", raw: { payload: { type: "custom_tool_call", call_id: "toolcall", name: "exec_command", input: "git status --short" } } },
    { key: "a", role: "assistant", content: "All checked", raw: {} },
  ] });
  const draft = sharing.create(w, "codex", "tool-payload", { options: { commands: false } });
  expect(JSON.stringify(draft.snapshot)).not.toContain("git status"); expect(JSON.stringify(draft.snapshot)).toContain("All checked");
});
it("keeps published content immutable after source collection changes or deletion", () => {
  const { w, sharing } = fixture(), draft = sharing.create(w, "claude", "original-session-12345");
  sharing.beginPublish(w, draft.id, draft.version, draft.digest, "request-1234");
  sharing.published(w, draft.id, "request-1234", { id: "abc123", url: "https://gist.github.com/example/abc123", revision: "a".repeat(40), viewer: null });
  store.db.prepare("DELETE FROM adit_history_sessions").run();
  expect(sharing.read(w, draft.id).snapshot).toEqual(draft.snapshot);
  expect(sharing.list(w).total).toBe(1);
  expect(() => sharing.update(w, draft.id, { title: "changed" })).toThrow();
});
it("redacts IPv4, IPv6, installation paths, encoded Windows paths and full secret values", () => {
  const privacy = new PublicationPrivacy();
  const text = privacy.text('E:\\Users\\Alice\\file.txt 192.168.1.1 2001:db8::1 ::1 /home/alice/.codex/sessions/session-123.jsonl ghp_' + "a".repeat(36), "sample");
  for (const forbidden of ["Alice", "192.168.1.1", "2001:db8::1", "::1", ".codex", "ghp_"]) expect(text).not.toContain(forbidden);
  for (let i = 1; i < privacy.redactions.length; i++) expect(privacy.redactions[i].start).toBeGreaterThanOrEqual(privacy.redactions[i - 1].end);
});
it("retains unmatched commits, distinguishes writer from submitter and snapshots results independently of analysis runs", () => {
  const { w, history } = fixture(); w.repositories = [root];
  history.write({ provider: "codex", id: "writer", cwd: root, messages: [{ key: "u", role: "user", content: "write code", raw: {} }] });
  const db = store.db, a = "a".repeat(40), b = "b".repeat(40), merge = "c".repeat(40);
  db.prepare("INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES (?,?,1,'x','done',1)").run("run", w.id);
  db.prepare("INSERT INTO adit_attribution_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("run", root, a, "claude", "original-session-12345", null, null, "sha", a, 10, 2, 7, 1, 0, 1, 1);
  db.prepare("INSERT INTO adit_attribution_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("run", root, b, null, null, null, null, null, null, 2, 0, 0, 0, 0, 0, 2);
  db.prepare("INSERT INTO adit_attribution_writers VALUES (?,?,?,?,?,?,?,?,?)").run("run", root, a, "codex", "writer", "src/a.ts", 7, 1, 0);
  db.prepare("INSERT INTO adit_attribution_alternatives VALUES (?,?,?,?,?,?,?,?,?,?)").run("run", root, a, "codex", "writer", "claude", "alternative", 0, 1, 0);
  const scope: PrScope = { repository: root, kind: "commits", head: null, base: null, headSha: null, baseSha: null, mergeBase: null, author: "me@example.org", digest: "scope", commits: [
    { sha: a, subject: "first", included: true, reason: null }, { sha: b, subject: "second", included: true, reason: null }, { sha: merge, subject: "merge", included: false, reason: "merge" },
  ] };
  const pr = new LocalPrDescriptions(db), result = pr.generate(w, scope, {});
  expect(result.summary).toMatchObject({ commits: 2, sessions: 2, unmatched: 1, excludedMerges: 1, lines: { eligible: 12, certain: 7, likely: 1, moved: 1, unknown: 3 } });
  expect(result.commits[0].submitter?.provider).toBe("claude"); expect(result.commits[0].writers[0].provider).toBe("codex");
  expect(result.commits[0].alternatives[0]).toMatchObject({sessionId:"alternative",certain:0,likely:1,possible:0});
  expect(db.prepare("SELECT role FROM adit_pr_description_commit_sessions WHERE session_id='alternative'").get()).toEqual({ role: "alternative" });
  expect(result.markdown).toContain("| Total | 2 conversations | 8 of 12 (66.7%) | 3 (25.0%) |");
  expect(result.markdown).toContain("No submitting conversation found"); expect(result.markdown).toContain("not the net PR diff");
  expect(result.markdown).not.toContain("original-session-12345"); expect(result.markdown).not.toContain("UNSELECTED TURN");
  db.prepare("DELETE FROM adit_attribution_runs").run(); db.prepare("DELETE FROM adit_history_sessions").run();
  expect(pr.read(w, result.id)).toEqual(result);
  expect(db.prepare("SELECT count(*) n FROM adit_pr_description_commits").get()).toEqual({ n: 3 });
  expect(() => pr.generate(w, scope, {})).toThrow("not been analyzed");
  const pending = pr.generate(w, scope, { lines: false, assistedBy: false, aditLabel: false });
  expect(pending.summary.pending).toBe(2); expect(pending.summary.unmatched).toBe(0); expect(pending.markdown).not.toContain("Assisted-by:"); expect(pending.markdown).not.toContain("by ADIT");
});
it("reads original evidence turns from compact summaries when the writer is an analysis representative", () => {
  const { w, history } = fixture(); w.repositories = [root];
  history.write({ provider:"codex", id:"representative", cwd:root, messages:[
    {key:"p",role:"user",content:"REPRESENTATIVE PROMPT MUST NOT BE INCLUDED",raw:{}},
  ] });
  const db=store.db, sha="e".repeat(40);
  const turn=db.prepare("SELECT id FROM adit_history_turns WHERE provider='claude' AND session_id='original-session-12345' ORDER BY ordinal LIMIT 1").get() as {id:string};
  db.prepare("INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES ('run',?,4,'x','done',1)").run(w.id);
  db.prepare("INSERT INTO adit_attribution_commits VALUES ('run',?,?,NULL,NULL,NULL,NULL,NULL,NULL,1,0,1,0,0,0,0)").run(root,sha);
  db.prepare("INSERT INTO adit_attribution_writers VALUES ('run',?,?,'codex','representative','a.ts',1,0,0)").run(root,sha);
  db.prepare("INSERT INTO adit_attribution_turns VALUES ('run',?,?,'claude','original-session-12345',?)").run(root,sha,turn.id);
  const scope:PrScope={repository:root,kind:"commits",head:null,base:null,headSha:null,baseSha:null,mergeBase:null,author:"me@example.org",digest:"turn-scope",
    commits:[{sha,subject:"change",included:true,reason:null}]};
  const result=new LocalPrDescriptions(db).generate(w,scope,{prompts:true});
  expect(result.commits[0].writers[0].sessionId).toBe("representative");
  expect(result.sessions.find(s=>s.sessionId==="original-session-12345")?.rangeModels).toEqual(["model-a"]);
  expect(db.prepare("SELECT session_id,turn_id FROM adit_pr_description_prompts WHERE description_id=?").all(result.id)).toEqual([
    {session_id:"original-session-12345",turn_id:turn.id},
  ]);
  expect(result.markdown).not.toContain("UNSELECTED TURN");
  expect(result.markdown).not.toContain("REPRESENTATIVE PROMPT MUST NOT BE INCLUDED");
  expect(result.summary).toMatchObject({commits:1,unmatched:1,sessions:2});
  expect(db.prepare("SELECT count(*) n FROM adit_history_sessions").get()).toEqual({n:2});
});
it("deduplicates request usage across native sessions and excludes child totals without merging identities", () => {
  const { w, history } = fixture(); w.repositories = [root];
  const db = store.db;
  for (const [id, parentId] of [["parent", undefined], ["continued", undefined], ["child", "parent"]] as const) history.write({ provider: "claude", id, cwd: root, parentId, relationship: parentId ? "subagent" : undefined, messages: [
    { key: "u", role: "user", content: "Test prompt", timestamp: "2026-10-20T00:00:00Z", raw: {} },
    { key: "a", role: "assistant", content: "Test reply", timestamp: "2026-10-20T00:00:02Z", model: "model", usage: { input_tokens: 10, output_tokens: 20 }, raw: { request_id: "shared-request" } },
  ] });
  db.prepare("INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES (?,?,1,'x','done',1)").run("run", w.id);
  const commits = ["parent", "continued", "child"].map((id, i) => {
    const sha = String(i + 1).repeat(40);
    db.prepare("INSERT INTO adit_attribution_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("run", root, sha, "claude", id, null, null, "sha", sha, 0, 0, 0, 0, 0, 0, 0);
    return { sha, subject: id, included: true, reason: null };
  });
  const scope: PrScope = { repository: root, kind: "commits", head: null, base: null, headSha: null, baseSha: null, mergeBase: null, author: "me", digest: "scope", commits };
  const pr = new LocalPrDescriptions(db), result = pr.generate(w, scope, {});
  expect(result.summary.sessions).toBe(3); expect(result.summary.prompts).toBe(2); expect(result.summary.duration).toBe(4000);
  expect(result.sessions.find(s => s.sessionId === "child")?.contextIncluded).toBe(false);
  expect(db.prepare("SELECT count(*) n,sum(input_tokens) input FROM adit_pr_description_usage WHERE description_id=?").get(result.id)).toEqual({ n: 1, input: 10 });
  expect(result.markdown).toContain("**— matched recorded session content**");
  const brief = pr.generate(w, scope, { detail: "brief", sessions: false, lines: false, assistedBy: false, aditLabel: false });
  for (const absent of ["| Commit", "eligible for comparison", "Assisted-by:", "by ADIT"]) expect(brief.markdown).not.toContain(absent);
  const project = pr.generate(w, scope, { detail: "project-template", language: "zh" }, { path: "template.md", digest: "text", text: "# Project\n{{ADIT_DISCLOSURE}}" });
  expect(project.markdown).toContain("# Project\n## AI 使用声明"); expect(project.markdown).toContain("| 合计 |");
});
it("paginates saved results without duplicates when a newer result is inserted", () => {
  const { w } = fixture(); w.repositories = [root];
  const pr = new LocalPrDescriptions(store.db);
  const scope: PrScope = { repository: root, kind: "commits", head: null, base: null, headSha: null, baseSha: null, mergeBase: null, author: "me", digest: "scope", commits: [{ sha: "a".repeat(40), subject: "pending", included: true, reason: null }] };
  const records = Array.from({ length: 103 }, () => pr.generate(w, scope, { lines: false }));
  const first = pr.list(w);
  expect(first.items).toHaveLength(50); expect(first.nextOffset).toBe(50);
  const inserted = pr.generate(w, scope, { lines: false });
  store.db.prepare("UPDATE adit_pr_descriptions SET created_at=? WHERE id=?").run(Date.now() + 60000, inserted.id);
  const next = pr.list(w, first.nextOffset!, first.nextCursor);
  expect(next.items).toHaveLength(50); expect(next.nextOffset).toBe(100);
  const last = pr.list(w, next.nextOffset!, next.nextCursor);
  const ids = [...first.items, ...next.items, ...last.items].map(r => r.id);
  expect(ids).toHaveLength(103); expect(new Set(ids).size).toBe(103);
  expect(new Set(ids)).toEqual(new Set(records.map(r => r.id))); expect(last.nextCursor).toBe(null);
  expect(() => pr.list(w, 0, "invalid")).toThrow("cursor");
});

it("labels submission status separately from code lines in new and saved descriptions", () => {
  const {w}=fixture(); w.repositories=[root];
  const db=store.db, a="a".repeat(40), b="b".repeat(40);
  db.prepare("INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES ('run',?,4,'x','done',1)").run(w.id);
  db.prepare("INSERT INTO adit_attribution_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("run",root,a,"claude","original-session-12345",null,null,"hash",a,2,0,2,0,0,0,0);
  db.prepare("INSERT INTO adit_attribution_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("run",root,b,null,null,null,null,null,null,2,0,2,0,0,0,0);
  const scope:PrScope={repository:root,kind:"commits",head:null,base:null,headSha:null,baseSha:null,mergeBase:null,author:"me@example.org",digest:"labels",commits:[
    {sha:a,subject:"first",included:true,reason:null},{sha:b,subject:"second",included:true,reason:null},
  ]};
  const pr=new LocalPrDescriptions(db);
  for(const language of ["en","zh"] as const) {
    const result=pr.generate(w,scope,{sessions:false,language});
    const zh=language==="zh";
    expect(result.markdown).toContain(zh ? "| 提交 | 提交会话 | 已匹配代码行 | 来源不明代码行 |" : "| Commit | Submitting conversation | Matched code lines | Untraced code lines |");
    expect(result.markdown).toContain(`| aaaaaaa first | ${zh?"已找到":"Found"} | 2 of 2 | 0 |`);
    expect(result.markdown).toContain(`| bbbbbbb second | ${zh?"未找到提交会话":"No submitting conversation found"} | 2 of 2 | 0 |`);
    expect(result.markdown).not.toContain("original-session-12345");
    const legacy=`Custom template text\n\n${zh ? "| 提交 | 匹配到会话内容 | 来源不明 |" : "| Commit | Matched session content | Not traced |"}\n| --- | ---: | ---: |\n| aaaaaaa first | 2 of 2 | 0 |\n| bbbbbbb second \\| part | 2 of 2 | 0 |\n| ${zh?"合计":"Total"} | 4 of 4 | 0 |\n\nSaved prompt and share link must stay unchanged.`;
    const saved={...result,markdown:legacy};
    db.prepare("UPDATE adit_pr_descriptions SET snapshot_json=?,markdown=? WHERE id=?").run(JSON.stringify(saved),legacy,result.id);
    const updated=pr.read(w,result.id);
    expect(updated.markdown).toContain(`| bbbbbbb second \\| part | ${zh?"未找到提交会话":"No submitting conversation found"} | 2 of 2 | 0 |`);
    expect(updated.markdown).toContain("Custom template text");
    expect(updated.markdown).toContain("Saved prompt and share link must stay unchanged.");
    expect(updated.summary).toEqual(result.summary);
    expect(JSON.parse((db.prepare("SELECT snapshot_json FROM adit_pr_descriptions WHERE id=?").get(result.id) as {snapshot_json:string}).snapshot_json)).toEqual(saved);
  }
});

it("pages published shares in groups of 50 with a stable cursor across new publications", () => {
  const { w, sharing } = fixture();
  const insert = store.db.prepare(`INSERT INTO adit_shares(id,workspace_id,provider,session_id,title,status,created_at,published_at,current_version_id,prompt_count,commit_count)
    VALUES (?,?,'codex','session','Title',?,1,?,'version',1,0)`);
  for (let i = 0; i < 101; i++) insert.run(`share-${String(i).padStart(3, "0")}`, w.id, "published", 1000);
  insert.run("draft", w.id, "ready", null);
  insert.run("foreign", "other-workspace", "published", 1000);
  const first = sharing.list(w);
  expect(first.total).toBe(101); expect(first.items).toHaveLength(50); expect(first.nextOffset).toBe(50);
  insert.run("new-share", w.id, "published", 2000);
  const second = sharing.list(w, first.nextOffset!, first.nextCursor);
  expect(second.items).toHaveLength(50); expect(second.nextOffset).toBe(100);
  const last = sharing.list(w, second.nextOffset!, second.nextCursor);
  expect(last.items).toHaveLength(1); expect(last.nextOffset).toBeNull(); expect(last.nextCursor).toBeNull();
  const ids = [...first.items, ...second.items, ...last.items].map(item => item.id);
  expect(new Set(ids).size).toBe(101); expect(ids).not.toContain("new-share");
});
