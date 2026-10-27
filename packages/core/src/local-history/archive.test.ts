import { afterEach, describe, expect, it, vi } from "vitest";
import * as codexReader from "./codex-file.js";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../local-state.js";
import { LocalHistory } from "./archive.js";
import {
  parseClaude,
  parseCodex,
  parseDeepseek,
  parseGemini,
} from "./parsers.js";
import { insideDirectory, sourceDefinitions } from "./sources.js";

const resources: { root: string; store: LocalStore }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of resources.splice(0)) {
    r.store.close();
    rmSync(r.root, { recursive: true, force: true });
  }
});
const lines = (...rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const item = (role: string, text: string, id?: string) => ({
  type: "response_item",
  payload: { type: "message", role, id, content: [{ type: "text", text }] },
});
const usage = {
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: 70,
        cached_input_tokens: 20,
        output_tokens: 8,
      },
    },
  },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adit-history-test-"));
  const workspace = join(root, "workspace"),
    source = join(root, "sessions");
  mkdirSync(workspace);
  mkdirSync(source);
  const store = new LocalStore(join(root, "state"));
  resources.push({ root, store });
  const archive = new LocalHistory(store.db);
  const path = join(source, "rollout-example.jsonl");
  const initial = lines(
    { type: "session_meta", payload: { id: "one", cwd: workspace } },
    { type: "turn_context", payload: { model: "model-a", effort: "medium" } },
    item("user", "first"),
    item("assistant", "answer"),
    usage,
  );
  writeFileSync(path, initial);
  return {
    root,
    workspace,
    source,
    store,
    archive,
    path,
    initial,
    sources: [{ id: "codex", paths: [source] }],
  };
}

describe("Core-owned local history", () => {
  it("retries a temporarily occupied file without losing other sessions or reporting failure",async()=>{
    const f=fixture(),read=codexReader.readCodexSession;
    const spy=vi.spyOn(codexReader,"readCodexSession").mockRejectedValueOnce(Object.assign(new Error("busy"),{code:"EBUSY"})).mockImplementation(read);
    const result=await f.archive.scan(f.workspace,f.sources);
    expect(result.errors).toEqual([]);expect(result.deferred).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);expect(f.archive.session("codex","one")!.messages).toHaveLength(2);
  });
  it("defers changing files but preserves real format errors and continues other files",async()=>{
    const f=fixture(),read=codexReader.readCodexSession;
    writeFileSync(join(f.source,"rollout-second.jsonl"),lines({type:"session_meta",payload:{id:"second",cwd:f.workspace}},item("user","good")));
    const spy=vi.spyOn(codexReader,"readCodexSession").mockImplementation(async(...args)=>{
      if(args[0]===f.path)throw new Error("Source changed while reading; retry on the next collection");
      return read(...args);
    });
    const deferred=await f.archive.scan(f.workspace,f.sources);
    expect(deferred.errors).toEqual([]);expect(deferred.deferred).toHaveLength(1);
    expect(f.archive.session("codex","second")).toBeDefined();
    spy.mockRestore();writeFileSync(f.path,"{broken}\n");
    const broken=await f.archive.scan(f.workspace,f.sources);
    expect(broken.errors).toHaveLength(1);expect(broken.deferred).toBeUndefined();
  });
  it("collects active Codex sessions without advancing cursors past concurrent appends",async()=>{
    const f=fixture();await f.archive.scan(f.workspace,f.sources);
    appendFileSync(f.path,lines(item("user","second")));
    const original=codexReader.codexThreadTitle;
    const title=vi.spyOn(codexReader,"codexThreadTitle").mockImplementation(async(...args)=>{
      appendFileSync(f.path,lines(item("assistant","concurrent")));
      return original(...args);
    });
    expect((await f.archive.scan(f.workspace,f.sources)).errors).toEqual([]);
    expect(f.archive.session("codex","one")!.messages).toHaveLength(3);
    expect(f.store.db.prepare("SELECT count(*) total FROM adit_history_jsonl_cursors").get()).toEqual({total:0});
    title.mockRestore();
    expect((await f.archive.scan(f.workspace,f.sources)).errors).toEqual([]);
    expect(f.archive.session("codex","one")!.messages).toHaveLength(4);
    expect((await f.archive.scan(f.workspace,f.sources)).updated).toBe(0);
  });
  it("skips unchanged source parsing after restart, retries failed changes and isolates selected scopes", async () => {
    const f=fixture(),read=vi.spyOn(codexReader,"readCodexSession");
    const other=join(f.root,"other");mkdirSync(other);
    const otherPath=join(f.source,"rollout-other.jsonl");
    writeFileSync(otherPath,lines({type:"session_meta",payload:{id:"other",cwd:other}},item("user","other project")));
    const scopes=[{path:f.workspace,providers:["codex"]},{path:other,providers:[]}];
    await f.archive.scan(f.workspace,f.sources,{scopes});
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.archive.session("codex","other")).toBeUndefined();
    await new LocalHistory(f.store.db).scan(f.workspace,f.sources,{scopes});
    expect(read).toHaveBeenCalledTimes(2);
    scopes[1].providers.push("codex");
    expect((await f.archive.scan(f.workspace,f.sources,{scopes})).scanned).toBe(2);
    expect(f.archive.session("codex","other")).toBeDefined();
    read.mockClear();
    await f.archive.scan(f.workspace,f.sources);
    expect(read).not.toHaveBeenCalled();
    appendFileSync(f.path,"{broken}\n");
    const tailRead=vi.spyOn(codexReader,"codexFileRows");
    for(let i=0;i<2;i++)expect((await f.archive.scan(f.workspace,f.sources,{scopes})).errors).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    expect(tailRead.mock.calls.filter(call=>call[0]===f.path && Number(call[2])>0)).toHaveLength(2);
    expect(f.archive.session("codex","one")!.messages).toHaveLength(2);
    writeFileSync(f.path,f.initial+lines(item("user","new turn")));
    expect((await f.archive.scan(f.workspace,f.sources,{scopes})).updated).toBe(1);
    expect(f.archive.session("codex","one")!.messages).toHaveLength(3);
  });
  it("keeps model and effort before first token record, without duplicate usage", () => {
    const f = fixture();
    const session = parseCodex(f.initial + lines(usage));
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1]).toMatchObject({
      model: "model-a",
      effort: "medium",
      usage: { output_tokens: 8 },
    });
  });
  it("does not attach usage across a user boundary", () => {
    const f = fixture();
    const session = parseCodex(f.initial + lines(item("user", "next"), usage));
    expect(session.messages[2].usage).toBeUndefined();
  });
  it("previews without persisting transcript or checkpoint", async () => {
    const f = fixture();
    expect(
      (await f.archive.scan(f.workspace, f.sources, { preview: true })).counts,
    ).toEqual({ codex: 1 });
    expect(f.archive.session("codex", "one")).toBeUndefined();
    expect(
      f.store.db.prepare("SELECT count(*) n FROM adit_history_sources").get(),
    ).toEqual({ n: 0 });
  });
  it("repeated collection is idempotent and appends preserve context after restart", async () => {
    const f = fixture();
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(0);
    appendFileSync(
      f.path,
      lines(item("user", "second"), item("assistant", "new answer"), usage),
    );
    const restarted = new LocalHistory(f.store.db);
    expect((await restarted.scan(f.workspace, f.sources)).counts).toEqual({
      codex: 1,
    });
    expect(restarted.session("codex", "one")?.messages).toHaveLength(4);
    expect(restarted.session("codex", "one")?.messages[3].model).toBe(
      "model-a",
    );
  });
  it("ignores incomplete trailing writes and consumes them once completed", async () => {
    const f = fixture();
    appendFileSync(f.path, '{"type":"response_item",');
    await f.archive.scan(f.workspace, f.sources);
    expect(f.archive.session("codex", "one")?.messages).toHaveLength(2);
    appendFileSync(
      f.path,
      '"payload":{"type":"message","role":"user","content":"next"}}\n',
    );
    await f.archive.scan(f.workspace, f.sources);
    expect(f.archive.session("codex", "one")?.messages).toHaveLength(3);
  });
  it("retains prior data and checkpoint on malformed or unsupported history", async () => {
    const f = fixture();
    await f.archive.scan(f.workspace, f.sources);
    const before = f.store.db
      .prepare("SELECT fingerprint FROM adit_history_sources")
      .get();
    appendFileSync(f.path, "{invalid}\n");
    expect((await f.archive.scan(f.workspace, f.sources)).errors).toHaveLength(
      1,
    );
    expect(f.archive.session("codex", "one")?.messages).toHaveLength(2);
    expect(
      f.store.db.prepare("SELECT fingerprint FROM adit_history_sources").get(),
    ).toEqual(before);
    expect(
      parseCodex(
        lines({
          type: "session_meta",
          payload: { id: "fork", cwd: f.workspace, forked_from_id: "one" },
        }),
      ),
    ).toMatchObject({id:"fork",parentId:"one",relationship:"fork",metadata:{lineageRetry:"Parent turns unresolved: one"}});
  });
  it("reconciles truncation and replacement without leaving old messages", async () => {
    const f = fixture();
    await f.archive.scan(f.workspace, f.sources);
    writeFileSync(
      f.path,
      lines(
        { type: "session_meta", payload: { id: "two", cwd: f.workspace } },
        item("user", "replaced"),
      ),
    );
    await f.archive.scan(f.workspace, f.sources);
    expect(f.archive.session("codex", "one")).toBeUndefined();
    expect(f.archive.session("codex", "two")?.messages).toHaveLength(1);
  });
  it("does not persist unrelated workspaces or duplicate overlapping sources", async () => {
    const f = fixture();
    const other = join(f.root, "other");
    mkdirSync(other);
    expect((await f.archive.scan(other, f.sources)).counts).toEqual({});
    expect(f.archive.session("codex", "one")).toBeUndefined();
    await f.archive.scan(f.workspace, [...f.sources, ...f.sources]);
    expect(f.archive.counts(f.workspace)).toEqual({ codex: 1 });
    expect(insideDirectory(f.root, join(f.root, "..named"))).toBe(true);
    expect(insideDirectory(f.workspace, other)).toBe(false);
  });
  it("supports cancellation before committing", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.archive.scan(f.workspace, f.sources, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(f.archive.counts(f.workspace)).toEqual({});
  });
  it("merges Claude response blocks and uses final usage", () => {
    const f = fixture();
    const text = lines(
      {
        type: "user",
        uuid: "u",
        sessionId: "claude-one",
        cwd: f.workspace,
        message: { content: "hello" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u",
        message: {
          id: "response",
          model: "claude-model",
          content: [{ type: "thinking", thinking: "step" }],
          usage: { output_tokens: 1 },
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        message: {
          id: "response",
          model: "claude-model",
          content: [{ type: "text", text: "answer" }],
          usage: { output_tokens: 9, cache_read_input_tokens: 4 },
        },
      },
    );
    const session = parseClaude(text, join(f.source, "claude-one.jsonl"));
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].content).toHaveLength(2);
    expect(session.messages[1].usage?.output_tokens).toBe(9);
  });
  it("preserves Claude child identity separately from its parent", () => {
    const f = fixture();
    const text = lines({
      type: "user",
      sessionId: "parent",
      cwd: f.workspace,
      message: { content: "child prompt" },
    });
    expect(
      parseClaude(text, join(f.source, "subagents", "agent-one.jsonl")),
    ).toMatchObject({ id: "agent-one", parentId: "parent" });
  });
  it("collects nested Claude subagents and interrupted message chains without conflicts or inflated counts", async () => {
    const f = fixture(), source = join(f.root, "claude");
    const nested = join(source, "parent", "subagents", "workflows", "wf-one");
    mkdirSync(nested, { recursive: true });
    const user = (uuid: string, parentUuid?: string) => ({
      type: "user", uuid, parentUuid, sessionId: "parent", cwd: f.workspace,
      message: { content: uuid },
    });
    const assistant = (uuid: string, parentUuid: string) => ({
      type: "assistant", uuid, parentUuid, sessionId: "parent", cwd: f.workspace,
      message: { content: uuid, usage: { output_tokens: 3 } },
    });
    writeFileSync(join(source, "parent.jsonl"), lines(
      user("u"), assistant("a", "u"),
      { type: "system", uuid: "system", parentUuid: "a" },
      user("next", "system"), assistant("reply", "next"),
    ));
    writeFileSync(join(nested, "agent-one.jsonl"), lines(
      user("u"), { type: "attachment", uuid: "attachment", parentUuid: "u" },
      assistant("a", "attachment"),
    ));
    writeFileSync(join(source, "parent", "subagents", "agent-two.jsonl"), lines(
      user("u"), assistant("a", "u"),
    ));
    const sources = [{ id: "claude", paths: [source] }];
    const collected = await f.archive.scan(f.workspace, sources, { sourceProgress: () => {} });
    expect(collected.errors).toEqual([]);
    expect(collected.counts).toEqual({ claude: 1 });
    expect(collected.sourceProgress?.[f.workspace].claude).toEqual({ completed: 1, total: 1, status: "done" });
    expect(f.archive.session("claude", "parent")?.messages.map(m => m.key)).toEqual(["u", "a", "next", "reply"]);
    for (const name of ["agent-one", "agent-two"]) {
      const child = f.archive.session("claude", `parent:${name}`);
      expect(child).toMatchObject({ parentId: "parent", relationship: "subagent" });
      expect(child?.messages.map(m => m.key)).toEqual(["u", "a"]);
      expect(child?.messages[1].usage).toEqual({ output_tokens: 3 });
    }
    expect(f.store.db.prepare("SELECT count(*) n FROM adit_history_sessions WHERE provider='claude'").get()).toEqual({ n: 3 });
    const repeated = await new LocalHistory(f.store.db).scan(f.workspace, sources);
    expect(repeated.errors).toEqual([]);
    expect(repeated.updated).toBe(0);
    expect(repeated.counts).toEqual({ claude: 1 });
  });
  it("reads DeepSeek TUI and Gemini without inventing missing usage", () => {
    const f = fixture();
    expect(
      parseDeepseek(
        JSON.stringify({
          metadata: { id: "ds", workspace: f.workspace, model: "ds-model" },
          messages: [{ role: "assistant", content: "done" }],
        }),
      ).messages[0],
    ).toMatchObject({ model: "ds-model" });
    expect(
      parseGemini(
        JSON.stringify({
          sessionId: "g",
          messages: [
            {
              type: "gemini",
              content: "done",
              tokens: { input: 20, output: 3, thoughts: 4, cached: 2 },
            },
          ],
        }),
        f.workspace,
      ).messages[0].usage,
    ).toMatchObject({ output_tokens: 7 });
  });
  it("enables implemented source readers", () => {
    expect(
      sourceDefinitions("/example", {}).find((p) => p.id === "cursor")
        ?.supported,
    ).toBe(true);
  });
});
