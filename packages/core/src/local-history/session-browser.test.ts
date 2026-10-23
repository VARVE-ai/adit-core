import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalStore } from "../local-state.js";
import { createHistorySchema } from "./schema.js";
import { StructuredHistory } from "./structured-store.js";
import { LocalAnalytics } from "./analytics.js";
import { LocalSessionBrowser } from "./session-browser.js";
import type { HistoryMessage } from "./types.js";
import { parseCursor } from "./cursor.js";

let root: string, store: LocalStore, analytics: LocalAnalytics;
afterEach(async () => {
  await analytics?.prices.close();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), "adit-session-browser-"));
  store = new LocalStore(join(root, "state"));
  createHistorySchema(store.db);
  analytics = new LocalAnalytics(store.db);
  analytics.prices.install({
    "test-model": {
      mode: "chat",
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000008,
      cache_read_input_token_cost: 0.0000005,
      cache_creation_input_token_cost: 0.0000025,
    },
  });
  const w = store.saveWorkspace({
    path: root,
    providers: ["claude", "codex"],
    repositories: [],
  });
  const history = new StructuredHistory(store.db),
    browser = new LocalSessionBrowser(store.db, analytics.prices);
  return { w, history, browser };
}
const m = (
  key: string,
  role: string,
  content: unknown,
  extra: Partial<HistoryMessage> = {},
): HistoryMessage => ({
  key,
  role,
  content,
  raw: {},
  timestamp: "2026-10-20T10:00:00Z",
  ...extra,
});
it("previews one real turn on either side, masks excerpts and opens the exact page by turn ID", () => {
  const { w, history, browser } = fixture();
  const secret = "ghp_" + createHash("sha256").update("commit-context-fixture").digest("hex").slice(0, 36);
  const messages: HistoryMessage[] = [];
  for (let i = 1; i <= 14; i++) {
    if (i === 10) messages.push(m("context", "user", "<environment_context>not a question</environment_context>"));
    messages.push(m(`q${i}`, "user", i === 9 ? [{ type: "input_image", image_url: "data:PRIVATE_IMAGE" }] : `question ${i}`));
    if (i < 14) messages.push(m(`a${i}`, "assistant", `answer ${i}`, { finalReply: true,
      model: "preview-model", usage: { input_tokens: 100, output_tokens: 20 }, timestamp: "2026-10-20T10:00:30Z" }));
    if (i === 10) messages.push(m("compact", "assistant", "PRIVATE_CONTEXT", { raw: { metadata: { compaction_output: true } } }));
  }
  history.write({ provider: "codex", id: "nearby", cwd: root, metadata: { title: "Original session title" }, messages });
  const later = browser.detail(w, "codex", "nearby", "normal", 8);
  const target = later.turns.find(t => t.prompt === "question 10")!;
  const draft = browser.editTurn(w, "codex", "nearby", target.id);
  browser.updateTurn(w, "codex", "nearby", target.id, draft.revision, [
    { id: draft.blocks.find(b => b.kind === "prompt")!.id, text: "edited question " + secret },
    { id: draft.blocks.find(b => b.text === "answer 10")!.id, text: "edited answer " + secret },
  ]);
  const result = browser.preview(w, "codex", "nearby", target.id);
  expect(result.session.title).toBe("Original session title");
  expect(result.turns.map(t => t.id)).toHaveLength(3);
  expect(result.turns.map(t => t.prompt)).toEqual(["", expect.stringContaining("edited question"), "question 11"]);
  expect(result.turns[0].imageCount).toBe(1);
  expect(result.turns[1].reply).toContain("edited answer");
  expect(result.turns[1].replyAt).toBe(Date.parse("2026-10-20T10:00:30Z"));
  expect(result.turns[1].usage).toMatchObject({ input: null, output: 20, requests: 1, models: ["preview-model"] });
  for (const hidden of [secret, "PRIVATE_IMAGE", "PRIVATE_CONTEXT", "not a question"])
    expect(JSON.stringify(result)).not.toContain(hidden);
  const opened = browser.detail(w, "codex", "nearby", "focused", undefined, "", target.id);
  expect(opened.matchTurnId).toBe(target.id);
  expect(opened.turns.some(t => t.id === target.id)).toBe(true);
  expect(opened.pageOffset).toBe(0);
  expect(opened.previousOffset).toBeNull();
  const last = browser.detail(w, "codex", "nearby", "normal", 8).turns.at(-1)!;
  expect(browser.preview(w, "codex", "nearby", last.id).turns.map(t => t.prompt)).toEqual(["question 13", "question 14"]);
  expect(browser.preview(w, "codex", "nearby", last.id).turns.at(-1)?.reply).toBeNull();
  expect(browser.preview(w, "codex", "nearby", last.id).turns.at(-1)?.replyAt).toBeNull();
  const first = browser.detail(w, "codex", "nearby").turns[0];
  expect(browser.preview(w, "codex", "nearby", first.id).turns.map(t => t.prompt)).toEqual(["question 1", "question 2"]);
  const deletion = browser.editTurn(w, "codex", "nearby", target.id);
  browser.deleteTurn(w, "codex", "nearby", target.id, deletion.revision);
  expect(browser.preview(w, "codex", "nearby", target.id)).toMatchObject({ targetTurnId: null, turns: [] });
  expect(() => browser.detail(w, "codex", "nearby", "normal", undefined, "", target.id)).toThrow("Turn not found");
});
it.each(["Native title", "   ", undefined])("uses a native title when present and otherwise the first prompt (%s)", title => {
  const { w, history, browser } = fixture();
  history.write({ id: "titled", provider: "claude", cwd: root, metadata: { title }, messages: [m("u", "user", "First question"), m("a", "assistant", "Answer")] });
  const expected = title?.trim() || "First question";
  expect(browser.list(w).items[0].title).toBe(expected);
  expect(browser.detail(w, "claude", "titled").session.title).toBe(expected);
  expect(browser.list(w, { query: expected }).total).toBe(1);
  expect(browser.detail(w, "claude", "titled").turns[0].prompt).toBe("First question");
});
it("keeps image-only turns visible in both modes without exposing binary data as text",()=>{
 const {w,history,browser}=fixture();
 history.write({id:'images',provider:'codex',cwd:root,messages:[
  m('p','user',[{type:'input_text',text:'<environment_context>context</environment_context>'},{type:'input_image',image_url:'data:PRIVATE'}]),
  m('a','assistant','Answer to image'),
 ]});
 for(const mode of ['normal','focused'] as const){const result=browser.detail(w,'codex','images',mode);
  expect(result.turns[0]).toMatchObject({imageCount:1,prompt:'',contextOnly:false});
  expect(result.turns[0].events.some(e=>e.text==='Answer to image')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');}
});
it("shows native compaction as context and retains the real answer in focused mode",()=>{
 const {w,history,browser}=fixture();history.write({id:'compact',provider:'codex',cwd:root,messages:[
  m('p','user','question'),m('a','assistant','actual answer',{finalReply:true}),
  m('s','assistant','## Task and Scope',{raw:{metadata:{compaction_output:true},payload:{phase:'final_answer'}}}),
  m('u','user','<turn_aborted>interrupted</turn_aborted>'),
 ]});
 const normal=browser.detail(w,'codex','compact','normal'),focused=browser.detail(w,'codex','compact','focused');
 expect(normal.turns[0].events.find(e=>e.text==='## Task and Scope')?.kind).toBe('system');
 expect(focused.turns[0].events.map(e=>e.text)).toEqual(['actual answer']);
 expect(normal.turns[1].contextOnly).toBe(true);
});

it("shows native continuation pages once, searches both parts and keeps edit/delete ownership",()=>{
 const {w,history,browser}=fixture();
 const rootSession={id:"native",provider:"codex",cwd:root,messages:[m("p","user","first question"),m("a","assistant","first answer")]};
 const page={id:"native_page",provider:"codex",cwd:root,parentId:"native",relationship:"continuation" as const,
   messages:[m("p","user","later question"),m("a","assistant","later answer") ,m("p2","user","delete later turn")]};
 history.write(rootSession);history.write(page);
 const before=store.db.prepare("SELECT id FROM adit_history_messages ORDER BY id").all();
 const list=browser.list(w);expect(list.total).toBe(1);expect(list.items[0]).toMatchObject({id:"native",messages:5,prompts:3,title:"first question"});
 const detail=browser.detail(w,"codex","native");expect(detail.turns.map(t=>t.prompt)).toEqual(["first question","later question","delete later turn"]);
 expect(detail.turns.map(t=>t.ordinal)).toEqual([1,2,3]);expect(detail.children).toEqual([]);
 expect(browser.list(w,{query:"later answer"}).items.map(s=>s.id)).toEqual(["native"]);
 expect(browser.detail(w,"codex","native_page").session.id).toBe("native");
 const preview=browser.preview(w,"codex","native_page",detail.turns[1].id);
 expect(preview.session.id).toBe("native");
 expect(preview.turns.map(t=>t.ordinal)).toEqual([1,2,3]);
 expect(browser.detail(w,"codex","native","normal",undefined,"",detail.turns[1].id).matchTurnId).toBe(detail.turns[1].id);
 expect(store.db.prepare("SELECT id FROM adit_history_messages ORDER BY id").all()).toEqual(before);
 const draft=browser.editTurn(w,"codex","native",detail.turns[1].id);
 browser.updateTurn(w,"codex","native",draft.turnId,draft.revision,[{id:draft.blocks[0].id,text:"edited later question"}]);
 const deletion=browser.editTurn(w,"codex","native",detail.turns[2].id);browser.deleteTurn(w,"codex","native",deletion.turnId,deletion.revision);
 history.write(rootSession);history.write(page);
 expect(browser.detail(w,"codex","native").turns.map(t=>t.prompt)).toEqual(["first question","edited later question"]);
 expect(browser.content(w,"codex","native",detail.turns[1].events[0].id,"reply").text).toBe("later answer");
 history.write({...page,id:"different-fork",parentId:"native",relationship:"fork"});expect(browser.list(w).total).toBe(2);
});

it("browses Cursor prompts with real dates and preserves wrappers, edits and deleted turns on recollection", () => {
  const { w, history, browser } = fixture();
  w.providers.push("cursor");
  const text = [
    { role: "user", message: { content: [{ type: "text", text: "<timestamp>Thursday, Sep 10, 2026, 1:27 PM (UTC+8)</timestamp>\n<user_query>Sep</user_query>" }] } },
    { role: "assistant", message: { content: "answer" } },
    { role: "user", message: { content: "<user_query>delete this turn</user_query>" } },
    { role: "assistant", message: { content: "deleted answer" } },
  ].map(r => JSON.stringify(r)).join("\n");
  const original = parseCursor(text, "cursor-session.jsonl", root);
  history.write(original);
  const before = browser.detail(w, "cursor", original.id);
  expect(before.session.title).toBe("Sep");
  expect(before.session.startedAt).toBe(Date.parse("2026-09-10T05:27:00Z"));
  for (const mode of ["normal", "focused"] as const)
    expect(browser.detail(w, "cursor", original.id, mode).turns[0].prompt).toBe("Sep");
  const draft = browser.editTurn(w, "cursor", original.id, before.turns[0].id);
  browser.updateTurn(w, "cursor", original.id, draft.turnId, draft.revision, [{ id: draft.blocks[0].id, text: "updated prompt" }]);
  const second = browser.editTurn(w, "cursor", original.id, before.turns[1].id);
  browser.deleteTurn(w, "cursor", original.id, second.turnId, second.revision);
  history.write(original);
  const after = browser.detail(w, "cursor", original.id);
  expect(after.turns.map(t => t.prompt)).toEqual(["updated prompt"]);
  expect(after.session.startedAt).toBe(before.session.startedAt);
  expect(history.read("cursor", original.id)!.messages[0].content).toEqual([{ type: "text", text: "<timestamp>Thursday, Sep 10, 2026, 1:27 PM (UTC+8)</timestamp>\n<user_query>updated prompt</user_query>" }]);
});

it("edits complete prompt/reply blocks, updates search, preserves tools/usage and reapplies edits on collection", () => {
  const { w, history, browser } = fixture();
  const original = { provider: "claude", id: "editable", cwd: root, messages: [
    m("u1", "user", "original question"),
    m("a1", "assistant", [{ type: "text", text: "original answer" }, { type: "text", text: "second block" }], {
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, model: "test-model",
    }),
    m("tool", "assistant", [{ type: "tool_use", id: "call", name: "Bash", input: { command: "echo kept" } }]),
    m("u2", "user", "next question"), m("a2", "assistant", "next reply"),
  ] };
  history.write(original);
  const before = browser.detail(w, "claude", "editable");
  const draft = browser.editTurn(w, "claude", "editable", before.turns[0].id);
  expect(draft.blocks.map(b => b.kind)).toEqual(["prompt", "reply", "reply"]);
  const replacement = "complete revised reply " + "long body\n".repeat(3000);
  browser.updateTurn(w, "claude", "editable", draft.turnId, draft.revision, draft.blocks.map((b, i) => ({ id: b.id, text: ["revised question", replacement, "revised second block"][i] })));
  const after = browser.detail(w, "claude", "editable");
  expect(after.turns[0].prompt).toBe("revised question");
  expect(after.turns[1]).toEqual(before.turns[1]);
  expect(after.cost).toBe(before.cost);
  expect(after.turns[0].usage).toEqual(before.turns[0].usage);
  expect(browser.list(w, { query: "original answer" }).total).toBe(0);
  expect(browser.list(w, { query: "revised question" }).items[0].title).toBe("revised question");
  expect(browser.editTurn(w, "claude", "editable", draft.turnId).blocks[1].text).toBe(replacement);
  expect(history.read("claude", "editable")!.messages[1].content).toEqual([{ type: "text", text: replacement }, { type: "text", text: "revised second block" }]);
  history.write({ ...original, messages: [...original.messages, m("a3", "assistant", "newly collected reply")] });
  expect(browser.editTurn(w, "claude", "editable", draft.turnId).blocks[1].text).toBe(replacement);
  expect(browser.detail(w, "claude", "editable").turns[0].events.some(e => e.kind === "tool")).toBe(true);
  expect(original.messages[0].content).toBe("original question");
});

it("edits and deletes only the selected reply block and reapplies it without losing tools or usage", () => {
  const { w, history, browser } = fixture();
  const original = { provider: "claude", id: "reply-actions", cwd: root, messages: [
    m("u", "user", "keep prompt"),
    m("a", "assistant", [{ type: "text", text: "target reply" }, { type: "text", text: "neighbor reply" }],
      { usage: { input_tokens: 10, output_tokens: 20 }, model: "test-model" }),
    m("t", "assistant", [{ type: "tool_use", id: "call", name: "Bash", input: { command: "echo keep" } }]),
    m("f", "assistant", "final reply"),
    m("u2", "user", "next turn"), m("a2", "assistant", "next reply"),
  ] };
  history.write(original);
  const before = browser.detail(w, "claude", original.id), first = before.turns[0], target = first.events[0];
  const draft = browser.editReply(w, "claude", original.id, first.id, target.id);
  expect(draft.blocks).toEqual([{ id: target.id, kind: "reply", text: "target reply" }]);
  expect(() => browser.editReply(w, "claude", original.id, first.id, first.promptBlockId!)).toThrow("Reply not found");
  expect(() => browser.editReply(w, "claude", original.id, first.id, first.events.find(e => e.kind === "tool")!.id)).toThrow("Reply not found");
  expect(() => browser.editReply(w, "claude", original.id, before.turns[1].id, target.id)).toThrow("Reply not found");
  expect(() => browser.updateReply(w, "claude", original.id, first.id, target.id, draft.revision,
    [{ id: target.id, text: "wrong" }, { id: first.promptBlockId, text: "wrong prompt" }])).toThrow("only the current reply");
  browser.updateReply(w, "claude", original.id, first.id, target.id, draft.revision, [{ id: target.id, text: "edited reply" }]);
  expect(() => browser.deleteReply(w, "claude", original.id, first.id, target.id, draft.revision)).toThrow("conversation changed");
  const edited = browser.editReply(w, "claude", original.id, first.id, target.id);
  expect(edited.blocks[0].text).toBe("edited reply");
  browser.deleteReply(w, "claude", original.id, first.id, target.id, edited.revision);
  expect(() => browser.editReply(w, "claude", original.id, first.id, target.id)).toThrow("Reply not found");
  expect(browser.list(w, { query: "edited reply" }).total).toBe(0);
  const after = browser.detail(w, "claude", original.id);
  expect(after.turns[0].prompt).toBe("keep prompt");
  expect(after.turns[0].events.map(e => e.id)).toEqual(first.events.slice(1).map(e => e.id));
  expect(after.turns[0].usage).toEqual(first.usage);
  expect(after.turns[1]).toEqual(before.turns[1]);
  history.write(original);
  expect(browser.detail(w, "claude", original.id).turns[0].events.map(e => e.id)).toEqual(first.events.slice(1).map(e => e.id));
  expect(browser.detail(w, "claude", original.id).turns[0].usage).toEqual(first.usage);
  expect((original.messages[1].content as { text: string }[])[0].text).toBe("target reply");
});

it("deletes exactly one whole turn including search/tools/usage, keeps other turns and never reimports it", () => {
  const { w, history, browser } = fixture();
  const original = { provider: "claude", id: "deletable", cwd: root, messages: [
    m("u1", "user", "keep first"), m("a1", "assistant", "keep first reply"),
    m("u2", "user", "remove this question"), m("a2", "assistant", "remove this reply", { usage: { input_tokens: 10, output_tokens: 20 } }),
    m("tool", "assistant", [{ type: "tool_use", id: "call", name: "Bash", input: { command: "echo remove-command" } }]),
    m("result", "user", [{ type: "tool_result", tool_use_id: "call", content: "remove output" }]),
    m("u3", "user", "keep last"), m("a3", "assistant", "keep last reply"),
  ] };
  history.write(original);
  const before = browser.detail(w, "claude", "deletable"), target = before.turns[1];
  const draft = browser.editTurn(w, "claude", "deletable", target.id);
  browser.deleteTurn(w, "claude", "deletable", target.id, draft.revision);
  const after = browser.detail(w, "claude", "deletable");
  expect(after.totalTurns).toBe(2);
  expect(after.session.messages).toBe(4);
  expect(after.session.prompts).toBe(2);
  expect(after.turns.map(t => [t.id, t.prompt])).toEqual([before.turns[0], before.turns[2]].map(t => [t.id, t.prompt]));
  expect(after.turns.map(t => t.ordinal)).toEqual([1, 2]);
  expect(browser.list(w, { query: "remove" }).total).toBe(0);
  expect(() => browser.content(w, "claude", "deletable", target.events[0].id, "reply")).toThrow("Event not found");
  expect(store.db.prepare("SELECT count(*) n FROM adit_history_tool_calls WHERE turn_id=?").get(target.id)).toEqual({ n: 0 });
  expect(store.db.prepare("SELECT count(*) n FROM adit_history_usage_entries WHERE turn_id=?").get(target.id)).toEqual({ n: 0 });
  history.write(original);
  expect(browser.detail(w, "claude", "deletable").turns.map(t => t.id)).toEqual(after.turns.map(t => t.id));
  // An active deleted turn may receive more native replies before the next prompt.
  const final = browser.editTurn(w, "claude", "deletable", after.turns[1].id);
  browser.deleteTurn(w, "claude", "deletable", final.turnId, final.revision);
  history.write({ ...original, messages: [...original.messages, m("later", "assistant", "later reply to deleted turn"), m("u4", "user", "new turn")] });
  expect(browser.detail(w, "claude", "deletable").turns.map(t => t.prompt)).toEqual(["keep first", "new turn"]);
  for (const t of browser.detail(w, "claude", "deletable").turns) {
    const current = browser.editTurn(w, "claude", "deletable", t.id);
    browser.deleteTurn(w, "claude", "deletable", t.id, current.revision);
  }
  expect(browser.detail(w, "claude", "deletable").totalTurns).toBe(0);
  expect(browser.list(w).items[0].id).toBe("deletable");
});

it("rejects stale edits, cross-turn blocks and outside-workspace mutations atomically", () => {
  const { w, history, browser } = fixture();
  for (const [id, cwd] of [["inside", root], ["outside", root + "-other"]]) history.write({ provider: "claude", id, cwd,
    messages: [m("u1", "user", "question"), m("a1", "assistant", "answer"), m("u2", "user", "other turn")] });
  const turns = browser.detail(w, "claude", "inside").turns;
  const draft = browser.editTurn(w, "claude", "inside", turns[0].id);
  expect(() => browser.updateTurn(w, "claude", "inside", turns[0].id, draft.revision - 1, [{ id: draft.blocks[0].id, text: "stale" }])).toThrow("conversation changed");
  expect(() => browser.updateTurn(w, "claude", "inside", turns[0].id, draft.revision, [{ id: draft.blocks[0].id, text: "rollback" }, { id: turns[1].promptBlockId, text: "wrong turn" }])).toThrow("Invalid conversation text");
  expect(browser.detail(w, "claude", "inside").turns[0].prompt).toBe("question");
  expect(() => browser.deleteTurn(w, "claude", "outside", turns[0].id, draft.revision)).toThrow("Session not found");
  expect(() => browser.deleteTurn(w, "claude", "inside", "missing", draft.revision)).toThrow("Turn not found");
  expect(() => browser.deleteTurn(w, "claude", "inside", turns[0].id, undefined)).toThrow("conversation changed");
  expect(browser.detail(w, "claude", "inside").totalTurns).toBe(2);
});

it("queries and paginates native sessions by scope, provider, activity, full text and commands without merging identities", () => {
  const { w, history, browser } = fixture();
  history.write({
    id: "first",
    provider: "claude",
    cwd: root,
    messages: [
      m("u", "user", "first prompt"),
      m("a", "assistant", "some detailed answer"),
    ],
  });
  history.write({
    id: "second",
    provider: "codex",
    cwd: root,
    messages: [
      m("u", "user", "second prompt"),
      m("a", "assistant", [
        {
          type: "function_call",
          name: "exec_command",
          call_id: "call",
          arguments: JSON.stringify({ cmd: "find needle-command" }),
        },
      ]),
    ],
  });
  history.write({
    id: "child",
    provider: "claude",
    cwd: root,
    parentId: "first",
    relationship: "subagent",
    messages: [m("u", "user", "child")],
  });
  history.write({
    id: "fork",
    provider: "claude",
    cwd: root,
    parentId: "first",
    relationship: "fork",
    messages: [m("u", "user", "fork")],
  });
  history.write({
    id: "outside",
    provider: "claude",
    cwd: root + "-neighbor",
    messages: [m("u", "user", "some detailed answer")],
  });
  expect(browser.list(w).total).toBe(3);
  expect(browser.list(w, { query: "detailed" }).items.map((s) => s.id)).toEqual(
    ["first"],
  );
  expect(
    browser.list(w, { query: "needle-command" }).items.map((s) => s.id),
  ).toEqual(["second"]);
  expect(browser.list(w, { provider: "codex" }).total).toBe(1);
  expect(browser.list(w, { onlyCommits: true }).total).toBe(0);
  expect(browser.list(w, { query: "%" }).total).toBe(0);
  expect(() => browser.detail(w, "claude", "outside")).toThrow(
    "Session not found",
  );
  expect(
    browser.detail(w, "claude", "first").children.map((s) => s.id),
  ).toEqual(["child"]);
  expect(browser.detail(w, "claude", "child").parent?.id).toBe("first");
  for (let i = 0; i < 55; i++)
    history.write({
      id: "page-" + i,
      provider: "claude",
      cwd: root,
      messages: [m("u", "user", "page prompt")],
    });
  const first = browser.list(w),
    second = browser.list(w, { offset: first.nextOffset! });
  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(8);
  expect(
    new Set(
      [...first.items, ...second.items].map((s) => s.provider + ":" + s.id),
    ).size,
  ).toBe(58);
});

it("normal shows intermediate work; focused keeps only final replies and does not promote a pre-tool status to an answer", () => {
  const { w, history, browser } = fixture();
  history.write({
    id: "s",
    provider: "claude",
    cwd: root,
    messages: [
      m("context", "system", "system instructions"),
      m("u1", "user", "first question"),
      m("a1", "assistant", "working on it"),
      m("tool", "assistant", [
        {
          type: "tool_use",
          id: "call",
          name: "Bash",
          input: { command: "echo hello" },
        },
      ]),
      m("result", "user", [
        { type: "tool_result", tool_use_id: "call", content: "hello" },
      ]),
      m("a2", "assistant", "final answer", {
        model: "test-model",
        effort: "high",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
      }),
      m("u2", "user", "second question"),
      m("a3", "assistant", "still working"),
      m("tool2", "assistant", [
        {
          type: "tool_use",
          id: "call2",
          name: "Bash",
          input: { command: "echo pending" },
        },
      ]),
    ],
  });
  const normal = browser.detail(w, "claude", "s");
  expect(normal.totalTurns).toBe(2);
  expect(normal.turns[0].events.map((e) => e.kind)).toEqual([
    "reply",
    "tool",
    "reply",
  ]);
  expect(normal.turns[0].openingEvents?.map((e) => e.text)).toEqual([
    "working on it",
  ]);
  expect(normal.turns[0].closingEvents?.map((e) => e.text)).toEqual([
    "final answer",
  ]);
  expect(normal.turns[1].openingEvents?.map((e) => e.text)).toEqual([
    "still working",
  ]);
  expect(normal.turns[1].closingEvents).toEqual([]);
  expect(normal.turns[0].usage).toMatchObject({
    input: 100,
    output: 50,
    cache: 20,
    cacheWrite: 10,
    models: ["test-model"],
    efforts: ["high"],
  });
  expect(normal.cost).toBe(635);
  expect(normal.context).toHaveLength(1);
  const focused = browser.detail(w, "claude", "s", "focused");
  expect(focused.turns[0].events.map((e) => e.text)).toEqual(["final answer"]);
  expect(focused.turns[1].events).toEqual([]);
  expect(focused.context).toEqual([]);
  expect(
    browser.content(w, "claude", "s", normal.turns[0].events[1].id, "tool")
      .text,
  ).toContain("hello");
});

it("masks transcript secrets, keeps large results lazy, and paginates long conversations", () => {
  const { w, history, browser } = fixture();
  const secret =
    "sk-ant-" +
    createHash("sha256").update("session-browser-fixture").digest("hex");
  history.write({
    id: "s",
    provider: "claude",
    cwd: root,
    messages: [
      m("u", "user", secret),
      m("a", "assistant", [
        {
          type: "tool_use",
          id: "call",
          name: "Bash",
          input: { command: "read config" },
        },
      ]),
      m("r", "user", [
        {
          type: "tool_result",
          tool_use_id: "call",
          content: secret + "\n" + "long output\n".repeat(6000),
        },
      ]),
      ...Array.from({ length: 10 }, (_, i) =>
        m("u" + i, "user", "prompt " + i),
      ),
    ],
  });
  const detail = browser.detail(w, "claude", "s");
  expect(detail.turns).toHaveLength(11);
  expect(detail.totalEntries).toBe(12);
  expect(detail.nextOffset).toBeNull();
  expect(JSON.stringify(detail)).not.toContain(secret);
  expect(JSON.stringify(detail).length).toBeLessThan(10000);
  const output = browser.content(
    w,
    "claude",
    "s",
    detail.turns[0].events[0].id,
    "tool",
  );
  expect(output.text).not.toContain(secret);
  expect(output.nextOffset).toBe(32000);
  const rawOutput = browser.content(
    w,
    "claude",
    "s",
    detail.turns[0].events[0].id,
    "tool-output",
  );
  expect(rawOutput.text).toContain("\nlong output\n");
  expect(rawOutput.text).not.toContain(secret);
  expect(rawOutput.nextOffset).toBe(32000);
  expect(() => browser.content(w, "claude", "s", "unknown", "tool")).toThrow(
    "Event not found",
  );
});

it("renders native script input and result text with actual newlines", () => {
  const { w, history, browser } = fixture();
  const script = 'const value = "hello";\ntext(value);';
  history.write({
    id: "script",
    provider: "codex",
    cwd: root,
    messages: [
      m("u", "user", "run this script"),
      m("call", "assistant", script, {
        raw: {
          payload: {
            type: "custom_tool_call",
            call_id: "script-call",
            name: "exec",
            input: script,
          },
        },
      }),
      m("result", "tool", "hello\nworld", {
        raw: {
          payload: {
            type: "custom_tool_call_output",
            call_id: "script-call",
            output: "hello\nworld",
          },
        },
      }),
    ],
  });
  const event = browser.detail(w, "codex", "script").turns[0].events[0];
  expect(event.text).toBe(script);
  expect(
    browser.content(w, "codex", "script", event.id, "tool-input").text,
  ).toBe(script);
  expect(
    browser.content(w, "codex", "script", event.id, "tool-output").text,
  ).toBe("hello\nworld");
});

it("keeps Codex context separate and navigates to a search hit beyond the initial turn and event pages", () => {
  const { w, history, browser } = fixture();
  const messages = [
    m(
      "ctx",
      "user",
      "# AGENTS.md instructions\n<INSTRUCTIONS>project rules</INSTRUCTIONS>\n<environment_context>runtime</environment_context>",
    ),
  ];
  for (let i = 0; i < 10; i++)
    messages.push(m("p" + i, "user", "question " + i));
  messages.push(m("opening", "assistant", "opening response"));
  for (let i = 0; i < 55; i++)
    messages.push(
      m(
        "call" + i,
        "assistant",
        JSON.stringify({
          cmd: "echo " + (i === 51 ? "needle-late-command" : i),
        }),
        {
          raw: {
            payload: {
              type: "function_call",
              call_id: "c" + i,
              name: "exec_command",
              arguments: JSON.stringify({
                cmd: "echo " + (i === 51 ? "needle-late-command" : i),
              }),
            },
          },
        },
      ),
    );
  messages.push(m("end", "assistant", "final response"));
  messages.push(
    m("cleanup", "assistant", "cleanup command", {
      raw: {
        payload: {
          type: "function_call",
          call_id: "cleanup",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "cleanup" }),
        },
      },
    }),
  );
  history.write({ id: "s", provider: "codex", cwd: root, messages });
  const first = browser.detail(w, "codex", "s");
  expect(first.turns[0].contextOnly).toBe(true);
  const longTurn = browser.turn(w, "codex", "s", first.turns.at(-1)!.id, "normal");
  expect(longTurn.nextOffset).toBe(40);
  expect(longTurn.events.some((e) => e.text === "final response")).toBe(false);
  expect(longTurn.openingEvents?.map((e) => e.text)).toEqual([
    "opening response",
  ]);
  expect(longTurn.closingEvents?.map((e) => e.text)).toEqual([
    "final response",
  ]);
  const found = browser.detail(
    w,
    "codex",
    "s",
    "normal",
    undefined,
    "needle-late-command",
  );
  expect(found.previousOffset).toBe(0);
  expect(found.matchTurnId).toBeTruthy();
  const turn = found.turns.find((t) => t.id === found.matchTurnId)!;
  expect(turn.previousOffset).toBeNull();
  expect(turn.promptVisible).toBe(false);
  expect(turn.openingEvents).toEqual([]);
  expect(turn.closingEvents?.map((e) => e.text)).toEqual(["final response"]);
  expect(
    turn.events.some(
      (e) =>
        e.id === turn.matchEventId && e.text.includes("needle-late-command"),
    ),
  ).toBe(true);
  expect(
    turn.events.filter((e) => e.kind === "reply").map((e) => e.text),
  ).toEqual(["final response"]);
  const focused = browser.detail(w, "codex", "s", "focused", 8);
  expect(focused.turns.at(-1)?.events.map((e) => e.text)).toEqual([
    "final response",
  ]);
});

it("splits logical conversations by viewer-local day and prices canonical usage on its actual day", () => {
  const { w, history, browser } = fixture();
  const reply = (key: string, timestamp: string, model = "test-model") => m(key, "assistant", key, {
    timestamp, model, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  history.write({ id: "days", provider: "claude", cwd: root, messages: [
    m("p1", "user", "before midnight", { timestamp: "2026-10-20T15:55:00Z" }),
    reply("a1", "2026-10-20T15:59:00Z"),
    reply("a2", "2026-10-20T16:02:00Z"),
  ] });
  history.write({ id: "page", provider: "claude", cwd: root, parentId: "days", relationship: "continuation", messages: [
    m("p2", "user", "next day", { timestamp: "2026-10-20T16:05:00Z" }),
    reply("a3", "2026-10-20T16:08:00Z"),
    reply("missing", "2026-10-20T16:09:00Z", "unknown-model"),
    reply("duplicate", "2026-10-20T16:10:00Z"),
  ] });
  store.db.prepare("UPDATE adit_history_usage_entries SET ledger_role='superseded' WHERE message_id IN (SELECT id FROM adit_history_messages WHERE source_key='duplicate')").run();
  const list = browser.list(w, { timezone: "Asia/Shanghai" });
  expect(list.total).toBe(2);
  expect(list.items.map(s => [s.dayIndex, s.dayCount])).toEqual([[2, 2], [1, 2]]);
  expect(list.messages).toBe(7);
  expect(list.providers[0].count).toBe(1);
  expect(list.items.map(s => ({ id: s.id, day: s.day, prompts: s.prompts, cost: s.cost, unpriced: s.unpriced }))).toEqual([
    { id: "days", day: "2026-10-21", prompts: 1, cost: 1200, unpriced: 1 },
    { id: "days", day: "2026-10-20", prompts: 1, cost: 600, unpriced: 0 },
  ]);
  expect(list.items[0].startedAt).toBe(Date.parse("2026-10-20T16:02:00Z"));
  expect(list.items[0].lastActivityAt).toBe(Date.parse("2026-10-20T16:10:00Z"));
  expect(browser.list(w, { timezone: "UTC" }).items).toHaveLength(1);
  expect(browser.list(w, { timezone: "Asia/Shanghai", query: "next day" }).items).toHaveLength(2);
  expect(browser.list(w, { provider: "codex" }).items).toHaveLength(0);
  expect(() => browser.list(w, { timezone: "invalid/zone" })).toThrow("Invalid timezone");
});

it("pages 50 day rows without repeating or losing days of one conversation", () => {
  const { w, history, browser } = fixture();
  history.write({ id: "long", provider: "claude", cwd: root, messages: Array.from({ length: 105 }, (_, i) =>
    m(`p${i}`, "user", `question ${i}`, { timestamp: new Date(Date.UTC(2026, 0, i + 1, 12)).toISOString() })) });
  const first = browser.list(w, { timezone: "UTC" });
  const second = browser.list(w, { timezone: "UTC", offset: first.nextOffset! });
  const third = browser.list(w, { timezone: "UTC", offset: second.nextOffset! });
  expect([first.items.length, second.items.length, third.items.length]).toEqual([50, 50, 5]);
  expect(third.nextOffset).toBeNull();
  expect(first.total).toBe(105);
  const rows = [...first.items, ...second.items, ...third.items];
  expect(new Set(rows.map(s => `${s.provider}:${s.id}:${s.day}`)).size).toBe(105);
  expect(rows.every(s => s.prompts === 1 && s.cost === null)).toBe(true);
  expect(rows.every((s, i) => s.dayCount === 105 && s.dayIndex === 105 - i)).toBe(true);
  expect(browser.list(w, { timezone: "UTC", sort: "oldest", limit: 1 }).items[0].dayIndex).toBe(1);
  const beyond = browser.list(w, { timezone: "UTC", offset: 500 });
  expect(beyond).toMatchObject({ total: 105, messages: 105, first: first.first, items: [], nextOffset: null });
  expect(beyond.providers).toEqual(first.providers);
});

it("prices only visible day rows without multiplying timezone work by the page size", () => {
  const { w, history, browser } = fixture();
  const messages = Array.from({ length: 105 }, (_, i) => {
    const timestamp = new Date(Date.UTC(2026, 0, i + 1, 12)).toISOString();
    return [m(`p${i}`, "user", `question ${i}`, { timestamp }), m(`a${i}`, "assistant", "answer", {
      timestamp, model: "test-model", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })];
  }).flat();
  history.write({ id: "priced-days", provider: "claude", cwd: root, messages });
  let dateCalls = 0;
  const original = store.db.function.bind(store.db);
  const define = vi.spyOn(store.db, "function").mockImplementation((...args: any[]) => {
    if (args[0] === "session_day") {
      const format = args[args.length - 1];
      args[args.length - 1] = (at: number | null) => { dateCalls++; return format(at); };
    }
    return Reflect.apply(original, store.db, args);
  });
  const estimate = vi.spyOn(analytics.prices, "estimate");
  try {
    const first = browser.list(w, { timezone: "UTC" });
    expect(first.total).toBe(105);
    expect(first.items).toHaveLength(50);
    expect(first.items.every(s => s.cost === 600 && s.prompts === 1 && s.messages === 2)).toBe(true);
    expect(estimate).toHaveBeenCalledTimes(50);
    // Count actual SQL date conversions, not wall-clock time. The old correlated
    // page lookup repeated this conversion for each candidate day of each request.
    expect(dateCalls).toBeLessThan(messages.length * 5);
    estimate.mockClear();
    const last = browser.list(w, { timezone: "UTC", offset: 100 });
    expect(last.items).toHaveLength(5);
    expect(last.items.every(s => s.cost === 600 && s.prompts === 1)).toBe(true);
    expect(estimate).toHaveBeenCalledTimes(5);
    estimate.mockClear();
    expect(browser.list(w, { timezone: "UTC", offset: 200 }).items).toEqual([]);
    expect(estimate).not.toHaveBeenCalled();
  } finally { define.mockRestore(); estimate.mockRestore(); }
});

it("returns empty list metadata without fabricating a day or pricing any usage", () => {
  const { w, browser } = fixture();
  const estimate = vi.spyOn(analytics.prices, "estimate");
  try {
    expect(browser.list(w)).toEqual({ items: [], providers: [], total: 0, messages: 0, first: null, nextOffset: null });
    expect(estimate).not.toHaveBeenCalled();
  } finally { estimate.mockRestore(); }
});

it("keeps undated messages separate and counts no new prompt for a reply-only day", () => {
  const { w, history, browser } = fixture();
  history.write({ id: "mixed", provider: "claude", cwd: root, messages: [
    m("p", "user", "question", { timestamp: "2026-10-20T12:00:00Z" }),
    m("a", "assistant", "late reply", { timestamp: "2026-10-23T12:00:00Z" }),
    m("undated", "assistant", "unknown time", { timestamp: undefined }),
  ] });
  const rows = browser.list(w, { timezone: "UTC" }).items;
  expect(rows.map(s => [s.dayIndex, s.dayCount])).toEqual([[2, 2], [1, 2], [null, 2]]);
  expect(rows.map(s => [s.day, s.prompts, s.messages, s.cost])).toEqual([
    ["2026-10-23", 0, 1, null], ["2026-10-20", 1, 1, null], [null, 0, 1, null],
  ]);
});

it.each(["normal", "focused"] as const)("pages exactly 50 timeline entries across turn boundaries in %s mode", mode => {
  const { w, history, browser } = fixture();
  history.write({ id: "pages", provider: "claude", cwd: root, messages: Array.from({ length: 53 }, (_, i) => [
    m(`p${i}`, "user", `question ${i}`), m(`a${i}`, "assistant", `reply ${i}`),
  ]).flat() });
  const first = browser.detail(w, "claude", "pages", mode);
  const second = browser.detail(w, "claude", "pages", mode, first.nextOffset!);
  const third = browser.detail(w, "claude", "pages", mode, second.nextOffset!);
  const entries = (page: typeof first) => page.turns.flatMap(t => [...(t.promptVisible ? [t.id] : []), ...t.events.map(e => e.id)]);
  expect([entries(first).length, entries(second).length, entries(third).length]).toEqual([50, 50, 6]);
  expect([first.pageOffset, second.pageOffset, third.pageOffset]).toEqual([0, 50, 100]);
  expect(third.nextOffset).toBeNull();
  expect(new Set([...entries(first), ...entries(second), ...entries(third)]).size).toBe(106);
  expect(entries(browser.detail(w, "claude", "pages", mode, third.previousOffset!))).toEqual(entries(second));
  const target = third.turns[0].id;
  const located = browser.detail(w, "claude", "pages", mode, undefined, "", target);
  expect(located.pageOffset).toBe(100);
  expect(located.previousOffset).toBe(50);
  expect(located.matchTurnId).toBe(target);
  expect(entries(located)).toEqual(entries(third));
});

it("splits a long turn without repeating its prompt, skipping events or sending future reply bodies", () => {
  const { w, history, browser } = fixture();
  history.write({ id: "long-turn", provider: "claude", cwd: root, messages: [m("p", "user", "question"),
    ...Array.from({ length: 104 }, (_, i) => m(`a${i}`, "assistant", `reply ${i}`)),
  ] });
  const first = browser.detail(w, "claude", "long-turn");
  const second = browser.detail(w, "claude", "long-turn", "normal", first.nextOffset!);
  const third = browser.detail(w, "claude", "long-turn", "normal", second.nextOffset!);
  expect([first,second,third].map(p => p.turns[0].events.length)).toEqual([49,50,5]);
  expect([first,second,third].map(p => p.turns[0].promptVisible)).toEqual([true,false,false]);
  expect(first.turns[0].closingEvents).toEqual([]);
  expect(third.turns[0].closingEvents?.[0].text).toBe("reply 103");
  expect(new Set([first,second,third].flatMap(p => p.turns[0].events.map(e => e.id))).size).toBe(104);
  expect([first,second,third].every(p => p.turns[0].nextOffset === null)).toBe(true);
  const found = browser.detail(w, "claude", "long-turn", "normal", undefined, "reply 73");
  expect(found.pageOffset).toBe(50);
  expect(found.turns[0].events.some(e => e.id === found.turns[0].matchEventId)).toBe(true);
});

it("marks a reply pending pagination when the page ends at its prompt", () => {
  const { w, history, browser } = fixture();
  history.write({ id: "boundary", provider: "claude", cwd: root, messages: [
    ...Array.from({ length: 50 }, (_, i) => m(`p${i}`, "user", `question ${i}`)), m("a", "assistant", "final reply"),
  ] });
  const first = browser.detail(w, "claude", "boundary", "focused");
  expect(first.turns.at(-1)).toMatchObject({ events: [], hasMoreEvents: true });
  expect(browser.detail(w, "claude", "boundary", "focused", 50).turns[0]).toMatchObject({ promptVisible: false, hasMoreEvents: false });
});

it("looks up tools by turn messages without rescanning every tool in a long session", () => {
  const { w, history, browser } = fixture();
  history.write({ id: "many-tools", provider: "codex", cwd: root, messages: Array.from({ length: 90 }, (_, i) => [
    m(`p${i}`, "user", `question ${i}`),
    m(`t${i}`, "assistant", [{ type: "function_call", call_id: `call${i}`, name: "exec_command",
      arguments: JSON.stringify({ cmd: `echo item-${i}` }) }]),
    m(`a${i}`, "assistant", `reply ${i}`),
  ]).flat() });
  const prepare = vi.spyOn(store.db, "prepare");
  let page = browser.detail(w, "codex", "many-tools");
  const tools: string[] = [];
  for (;;) {
    tools.push(...page.turns.flatMap(t => t.events.filter(e => e.kind === "tool").map(e => e.id)));
    if (page.nextOffset === null) break;
    page = browser.detail(w, "codex", "many-tools", "normal", page.nextOffset);
  }
  const query = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.startsWith("SELECT t.id,t.message_id,"));
  prepare.mockRestore();
  expect(tools).toHaveLength(90);
  expect(new Set(tools).size).toBe(90);
  expect(page.totalEntries).toBe(270);
  expect(query).toBeTruthy();
  const turn = store.db.prepare("SELECT id FROM adit_history_turns WHERE session_id=? ORDER BY ordinal LIMIT 1").get("many-tools") as { id: string };
  const plan = store.db.prepare("EXPLAIN QUERY PLAN " + query).all(JSON.stringify(["many-tools"]), "codex", turn.id) as { detail: string }[];
  // A query-plan assertion is stable across machine speeds and guards the
  // regression that spent over a minute rescanning a real 264-turn session.
  expect(plan.some(row => /SEARCH m USING .*adit_history_messages_turn.*turn_id=/.test(row.detail))).toBe(true);
  expect(plan.some(row => /SEARCH t USING .*adit_history_tools_message.*message_id=/.test(row.detail))).toBe(true);
});

it.each(["normal", "focused"] as const)("shows only the selected day's conversation and metrics in %s mode", mode => {
  const { w, history, browser } = fixture();
  for (const [i, id] of ["days", "continued"].entries()) history.write({ id, provider: "claude", cwd: root,
    ...(i ? { parentId: "days", relationship: "continuation" as const } : {}), messages: [
      m(`p${i}`, "user", `question day ${i}`, { timestamp: `2026-10-${21 + i}T01:00:00Z` }),
      m(`a${i}`, "assistant", `needle answer day ${i}`, { timestamp: `2026-10-${21 + i}T02:00:00Z`, model: "test-model",
        usage: { input_tokens: 100 * (i + 1), output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    ] });
  const before = store.db.prepare("SELECT id,transcript_revision FROM adit_history_sessions ORDER BY id").all();
  const rows = browser.list(w, { timezone: "Asia/Shanghai" }).items;
  for (const row of rows) {
    const day = { day: row.day, timezone: "Asia/Shanghai" };
    const detail = browser.detail(w, "claude", "days", mode, undefined, "needle", undefined, day);
    expect(detail.session).toMatchObject({ id: "days", prompts: row.prompts, messages: row.messages,
      startedAt: row.startedAt, lastActivityAt: row.lastActivityAt });
    expect(detail.cost).toBe(row.cost);
    expect(detail.models).toEqual(["test-model"]);
    expect(detail.turns).toHaveLength(1);
    const i = row.day === "2026-10-21" ? 0 : 1;
    expect(detail.turns[0].prompt).toBe(`question day ${i}`);
    expect(detail.turns[0].events.map(e => e.text)).toEqual([`needle answer day ${i}`]);
    expect(detail.matchTurnId).toBe(detail.turns[0].id);
    expect(detail.turns[0].usage.input).toBe(100 * (i + 1));
    expect(detail.nextOffset).toBeNull();
  }
  expect(browser.detail(w, "claude", "days").totalTurns).toBe(2);
  expect(store.db.prepare("SELECT id,transcript_revision FROM adit_history_sessions ORDER BY id").all()).toEqual(before);
});

it("pages a midnight-spanning turn within its day without repeating yesterday's prompt or tomorrow's replies", () => {
  const { w, history, browser } = fixture();
  history.write({ id: "midnight", provider: "claude", cwd: root, messages: [
    m("p", "user", "yesterday question", { timestamp: "2026-10-20T15:59:00Z" }),
    ...Array.from({ length: 65 }, (_, i) => m(`a${i}`, "assistant", `today reply ${i}`, { timestamp: "2026-10-20T16:01:00Z" })),
    m("later", "user", "tomorrow question", { timestamp: "2026-10-21T16:00:00Z" }),
  ] });
  const yesterday = browser.detail(w, "claude", "midnight", "normal", undefined, "", undefined, { day: "2026-10-20", timezone: "Asia/Shanghai" });
  expect(yesterday.totalEntries).toBe(1);
  expect(yesterday.turns[0].events).toEqual([]);
  const day = { day: "2026-10-21", timezone: "Asia/Shanghai" };
  const first = browser.detail(w, "claude", "midnight", "normal", undefined, "", undefined, day);
  const last = browser.detail(w, "claude", "midnight", "normal", first.nextOffset!, "", undefined, day);
  expect(first.session).toMatchObject({ prompts: 0, messages: 65 });
  expect([first.totalEntries, first.turns[0].events.length, last.turns[0].events.length]).toEqual([65,50,15]);
  expect([first.turns[0].promptVisible, last.turns[0].promptVisible]).toEqual([false,false]);
  expect(last.nextOffset).toBeNull();
  expect(new Set([...first.turns[0].events, ...last.turns[0].events].map(e => e.id)).size).toBe(65);
  expect(browser.detail(w, "claude", "midnight", "focused", undefined, "", undefined, day).turns[0].events.map(e => e.text)).toEqual(["today reply 64"]);
});

it("keeps context pagination, undated content, timezone boundaries and invalid day filters separate", () => {
  const { w, history, browser } = fixture();
  history.write({ id: "context-days", provider: "claude", cwd: root, messages: [
    m("unknown", "system", "undated context", { timestamp: undefined }),
    m("prior", "system", "previous day context", { timestamp: "2026-11-01T03:59:00Z" }),
    ...Array.from({ length: 60 }, (_, i) => m(`s${i}`, "system", `selected context ${i}`, { timestamp: i < 30 ? "2026-11-01T05:30:00Z" : "2026-11-01T06:30:00Z" })),
    m("next", "user", "next day question", { timestamp: "2026-11-02T05:00:00Z" }),
  ] });
  const day = { day: "2026-11-01", timezone: "America/New_York" };
  const first = browser.detail(w, "claude", "context-days", "normal", undefined, "", undefined, day);
  expect(first.session).toMatchObject({ prompts: 0, messages: 60 });
  expect(first.context).toHaveLength(50);
  const last = browser.context(w, "claude", "context-days", first.contextNextOffset!, day);
  expect(last.events).toHaveLength(10);
  expect(last.nextOffset).toBeNull();
  expect([...first.context, ...last.events].every(e => e.text.startsWith("selected context"))).toBe(true);
  const undated = browser.detail(w, "claude", "context-days", "normal", undefined, "", undefined, { day: null });
  expect(undated.session.messages).toBe(1);
  expect(undated.context.map(e => e.text)).toEqual(["undated context"]);
  expect(browser.detail(w, "claude", "context-days", "normal", undefined, "", undefined, { day: "2026-12-01" }).session.messages).toBe(0);
  for (const invalid of ["", "2026-02-30", "bad"])
    expect(() => browser.detail(w, "claude", "context-days", "normal", undefined, "", undefined, { day: invalid })).toThrow("Invalid day");
  expect(() => browser.detail(w, "claude", "context-days", "normal", undefined, "", undefined, { day: null, timezone: "invalid/zone" })).toThrow("Invalid timezone");
});
