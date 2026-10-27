import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { LocalHistory } from "./archive.js";
import { StructuredHistory } from "./structured-store.js";
import { parseCursor } from "./cursor.js";
import { parseHarness, decodeHarness } from "./deepseek-harness.js";
import { parseGemini } from "./parsers.js";
import { sourceDefinitions } from "./sources.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture(provider: string) {
  const root = mkdtempSync(join(tmpdir(), "adit-sources-"));
  const source = join(root, "source"),
    workspace = join(root, "workspace");
  mkdirSync(source);
  mkdirSync(workspace);
  const db = new Database(":memory:");
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    workspace,
    db,
    archive: new LocalHistory(db),
    sources: [{ id: provider, paths: [source] }],
  };
}
function write(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
}
const lines = (...rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
function openCode(f: ReturnType<typeof fixture>) {
  const path = join(f.source, `${f.sources[0].id}.db`),
    db = new Database(path);
  db.pragma("journal_mode=WAL");
  db.pragma("wal_autocheckpoint=0");
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE project (id TEXT PRIMARY KEY,worktree TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT,time_created INTEGER);`);
  cleanup.push(() => db.close());
  const session = (id: string, cwd = f.workspace, parent?: string) =>
    db
      .prepare("INSERT INTO session VALUES (?,'project',?,?,1,1)")
      .run(id, cwd, parent || null);
  const message = (id: string, sid: string, text: string) => {
    db.prepare("INSERT INTO message VALUES (?,?,?,1)").run(
      id,
      sid,
      JSON.stringify({
        role: "assistant",
        modelID: "example-model",
        tokens: { input: 12, output: 4 },
      }),
    );
    db.prepare("INSERT INTO part VALUES (?,?,?,?,1)").run(
      `part-${id}`,
      id,
      sid,
      JSON.stringify({ type: "text", text }),
    );
  };
  return { db, path, session, message };
}

describe("additional provider archive integration", () => {
  it("reads both IcodeMate storage families without changing the provider namespace", async () => {
    const f = fixture("icodemate");
    const storage = openCode(f);
    storage.session("database-session");
    storage.message("m", "database-session", "database");
    write(join(f.source, "projects/work/cli.jsonl"), lines({ type: "user", uuid: "u", sessionId: "cli", cwd: f.workspace, message: { content: "cli" } }));
    expect((await f.archive.scan(f.workspace, f.sources)).counts.icodemate).toBe(2);
    expect(f.archive.session("icodemate", "cli")?.messages[0].content).toBe("cli");
    expect(f.archive.session("icodemate", "database-session")?.messages).toHaveLength(1);
  });
  it("archives Zencoder rows and leaves unrelated workspace sessions out", async () => {
    const f = fixture("zencoder");
    write(join(f.source, "z.jsonl"), lines({ id: "z" }, { role: "system", content: `Working directory: ${f.workspace}` }, { role: "user", content: "hello" }));
    write(join(f.source, "elsewhere.jsonl"), lines({ id: "elsewhere" }, { role: "system", content: `Working directory: ${f.root}` }));
    expect((await f.archive.scan(f.workspace, f.sources)).counts.zencoder).toBe(1);
    expect(f.archive.session("zencoder", "elsewhere")).toBeUndefined();
  });
  it("archives Qwen discovery without writes, then collects and skips unchanged input", async () => {
    const f = fixture("qwen");
    const path = join(f.source, "encoded-project/chats/q.jsonl");
    write(path, lines({ type: "user", sessionId: "q", cwd: f.workspace, message: { role: "user", parts: [{ text: "question" }] } }));
    const preview = await f.archive.scan(f.workspace, f.sources, { preview: true });
    expect(preview.counts.qwen).toBe(1);
    expect(f.archive.session("qwen", "q")).toBeUndefined();
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(0);
  });
  it("rechecks Command Code workspace metadata without changes to the transcript", async () => {
    const f = fixture("commandcode");
    const path = join(f.source, "project/thread.jsonl");
    write(path, lines({ role: "user", content: "question" }));
    write(path.replace(".jsonl", ".meta.json"), { cwd: f.workspace });
    write(join(f.source, "project/thread.prompts.jsonl"), "not a session\n");
    const first = await f.archive.scan(f.workspace, f.sources);
    expect(first.errors).toEqual([]);
    expect(first.counts.commandcode).toBe(1);
    write(path.replace(".jsonl", ".meta.json"), { cwd: f.workspace, title: "renamed" });
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
    write(path.replace(".jsonl", ".meta.json"), "invalid");
    expect((await f.archive.scan(f.workspace, f.sources)).errors).toHaveLength(1);
    expect(f.archive.session("commandcode", "thread")?.messages).toHaveLength(1);
  });
  it("keeps MiMoCode as its own namespace and observes committed WAL messages", async () => {
    const f = fixture("mimocode");
    const storage = openCode(f);
    storage.session("s");
    storage.message("m1", "s", "first");
    expect((await f.archive.scan(f.workspace, f.sources)).counts.mimocode).toBe(1);
    storage.message("m2", "s", "second");
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
    expect(f.archive.session("mimocode", "s")?.messages).toHaveLength(2);
    expect(f.archive.session("opencode", "s")).toBeUndefined();
  });
  it("reads MiMoCode's session_diff JSON store", async () => {
    const f = fixture("mimocode");
    write(join(f.source, "storage/session_diff/project/s.json"), { id: "s", directory: f.workspace });
    write(join(f.source, "storage/message/s/m.json"), { id: "m", sessionID: "s", role: "user", time: { created: 1 } });
    write(join(f.source, "storage/part/m/p.json"), { id: "p", messageID: "m", sessionID: "s", type: "text", text: "hello" });
    expect((await f.archive.scan(f.workspace, f.sources)).errors).toEqual([]);
    expect(f.archive.session("mimocode", "s")?.messages).toHaveLength(1);
  });
  it("refreshes Cline when only its transcript changes and retains data after corruption", async () => {
    const f = fixture("cline");
    write(join(f.source, "s/s.json"), { session_id: "s", cwd: f.workspace, metadata: { aggregateUsage: { inputTokens: 20 } } });
    const path = join(f.source, "s/s.messages.json");
    const msg = { id: "m", role: "assistant", ts: 1000, content: [{ type: "text", text: "hello" }], modelInfo: { id: "model" }, metrics: { inputTokens: 3 } };
    write(path, { sessionId: "s", messages: [msg] });
    expect((await f.archive.scan(f.workspace, f.sources)).counts.cline).toBe(1);
    expect(f.archive.session("cline", "s")?.messages[0].usage).toEqual({ inputTokens: 3 });
    write(path, { sessionId: "s", messages: [msg, { ...msg, id: "m2" }] });
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
    write(path, { sessionId: "wrong", messages: [] });
    expect((await f.archive.scan(f.workspace, f.sources)).errors).toHaveLength(1);
    expect(f.archive.session("cline", "s")?.messages).toHaveLength(2);
  });
  it("preserves Vibe tools and session totals without assigning totals to every message", async () => {
    const f = fixture("vibe");
    write(join(f.source, "s/meta.json"), { session_id: "s", environment: { working_directory: f.workspace }, stats: { session_prompt_tokens: 30 } });
    const path = join(f.source, "s/messages.jsonl");
    write(path, lines({ role: "assistant", content: "hello", tool_calls: [{ id: "t", function: { name: "read", arguments: { path: "a" } } }] }));
    expect((await f.archive.scan(f.workspace, f.sources)).counts.vibe).toBe(1);
    const session = f.archive.session("vibe", "s")!;
    expect(session.metadata?.usage).toEqual({ session_prompt_tokens: 30 });
    expect(session.messages[0].usage).toBeUndefined();
    write(path, lines({ role: "user", content: "changed" }));
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
  });
});

describe("independent provider readers", () => {
  it("reparses unchanged Cursor files once after the parser update, leaving other providers cached", async () => {
    const f = fixture("cursor");
    const slug = f.workspace.split(/[:\\/._-]+/).filter(Boolean).join("-");
    const path = join(f.source, slug, "agent-transcripts", "s.jsonl");
    const content = "<timestamp>Thursday, Sep 10, 2026, 1:27 PM (UTC+8)</timestamp>\n<user_query>到底</user_query>";
    write(path, lines({ role: "user", message: { content } }));
    const other = join(f.root, "claude");
    write(join(other, "c.jsonl"), lines({ type: "user", uuid: "u", sessionId: "c", cwd: f.workspace, message: { content: "unchanged" } }));
    const sources = [...f.sources, { id: "claude", paths: [other] }];
    expect((await f.archive.scan(f.workspace, sources)).updated).toBe(2);
    // Recreate the old archive and both old checkpoint versions, without changing source stats.
    const session = f.archive.session("cursor", "s")!;
    new StructuredHistory(f.db).write({ ...session, messages: session.messages.map(m => ({ ...m, timestamp: undefined })) });
    f.db.prepare("UPDATE adit_history_sessions SET first_prompt=? WHERE provider='cursor'").run(content);
    f.db.exec("UPDATE adit_history_sources SET parser_version=5 WHERE provider='cursor'; UPDATE adit_history_file_checkpoints SET parser_version=5 WHERE provider='cursor';");
    const refreshed = await new LocalHistory(f.db).scan(f.workspace, sources);
    expect(refreshed.errors).toEqual([]);
    expect(refreshed.updated).toBe(1);
    expect(f.archive.session("cursor", "s")!.messages[0].timestamp).toBe("2026-09-10T05:27:00.000Z");
    expect(f.db.prepare("SELECT first_prompt,started_at FROM adit_history_sessions WHERE provider='cursor'").get()).toEqual({ first_prompt: "到底", started_at: Date.parse("2026-09-10T05:27:00Z") });
    expect((await new LocalHistory(f.db).scan(f.workspace, sources)).updated).toBe(0);
  });
  it("does not guess a Cursor workspace when multiple selected roots share an encoded path",async()=>{
    const f=fixture("cursor"),one=join(f.root,"one-two"),two=join(f.root,"one_two");mkdirSync(one);mkdirSync(two);
    const slug=one.split(/[:\\/._-]+/).filter(Boolean).join("-");
    write(join(f.source,slug,"agent-transcripts","s.jsonl"),lines({role:"user",message:{content:"question"}}));
    const result=await f.archive.scan(one,f.sources,{scopes:[{path:one,providers:["cursor"]},{path:two,providers:["cursor"]}]});
    expect(result.errors).toEqual([expect.stringContaining("unambiguously")]);
    expect(f.db.prepare("SELECT count(*) n FROM adit_history_sessions").get()).toEqual({n:0});
    expect((await f.archive.scan(one,f.sources)).updated).toBe(1);
  });
  it("keeps other projects in a shared database when a single project is recollected", async () => {
    const f=fixture("opencode"),source=openCode(f),other=join(f.root,"outside");mkdirSync(other);
    source.session("one");source.session("two",other);
    source.message("m1","one","first");source.message("m2","two","second");
    const scopes=[{path:f.workspace,providers:["opencode"]},{path:other,providers:["opencode"]}];
    expect((await f.archive.scan(f.workspace,f.sources,{scopes})).updated).toBe(2);
    source.message("m3","one","changed first");
    expect((await f.archive.scan(f.workspace,f.sources)).updated).toBe(1);
    expect(f.archive.session("opencode","two")!.messages).toHaveLength(1);
    source.db.prepare("DELETE FROM session WHERE id='one'").run();
    expect((await f.archive.scan(f.workspace,f.sources)).updated).toBe(1);
    expect(f.archive.session("opencode","one")).toBeUndefined();
    expect(f.archive.session("opencode","two")!.messages).toHaveLength(1);
  });
  it.each(["opencode", "kilo"])(
    "reads multiple %s sessions, WAL-only updates and unchanged checkpoints",
    async (provider) => {
      const f = fixture(provider),
        source = openCode(f);
      source.session("one");
      source.session("two");
      source.session("child", f.workspace, "one");
      source.session("other", join(f.root, "outside"));
      for (const id of ["one", "two", "child", "other"])
        source.message(id, id, `answer-${id}`);
      source.db.pragma("wal_checkpoint(TRUNCATE)");
      const before = statSync(source.path).mtimeMs;
      const preview = await f.archive.scan(f.workspace, f.sources, {
        preview: true,
      });
      expect(preview.errors).toEqual([]);
      expect(preview.counts).toEqual({ [provider]: 2 });
      expect(f.archive.session(provider, "one")).toBeUndefined();
      expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(3);
      expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(0);
      expect(f.archive.session(provider, "other")).toBeUndefined();
      source.db
        .prepare("UPDATE part SET data=? WHERE id='part-one'")
        .run(
          JSON.stringify({
            type: "text",
            text: "edited without session metadata change",
          }),
        );
      expect(statSync(source.path).mtimeMs).toBe(before);
      expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
      expect(f.archive.session(provider, "one")?.messages[0]).toMatchObject({
        model: "example-model",
        content: [{ text: "edited without session metadata change" }],
        usage: { input: 12 },
      });
      source.db
        .prepare("UPDATE part SET data='invalid' WHERE id='part-one'")
        .run();
      expect(
        (await f.archive.scan(f.workspace, f.sources)).errors.length,
      ).toBeGreaterThan(0);
      expect(f.archive.session(provider, "one")?.messages[0].content).toEqual([
        { type: "text", text: "edited without session metadata change" },
      ]);
    },
  );
  it("uses v2 projections and migration cursor, without resurrecting copied legacy rows", async () => {
    const f = fixture("opencode"),
      s = openCode(f);
    s.session("a");
    s.session("b");
    s.session("c");
    s.message("old", "b", "old answer");
    s.db.exec(`CREATE TABLE session_v2 AS SELECT * FROM session WHERE id='b';
      CREATE TABLE session_message (id TEXT,type TEXT,session_id TEXT,data TEXT,time_created INTEGER,seq INTEGER);
      CREATE TABLE kv (key TEXT,value TEXT);`);
    s.db
      .prepare("INSERT INTO kv VALUES ('migration.v1-v2',?)")
      .run(JSON.stringify({ phase: "sessions", cursor: "b" }));
    s.db
      .prepare(
        "INSERT INTO session_message VALUES ('old','assistant','b',?,2,1)",
      )
      .run(
        JSON.stringify({
          model: { id: "v2-model" },
          content: [{ type: "text", text: "projected" }],
        }),
      );
    const result = await f.archive.scan(f.workspace, f.sources);
    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({ opencode: 2 });
    expect(f.archive.session("opencode", "c")).toBeUndefined();
    expect(f.archive.session("opencode", "b")?.messages).toHaveLength(1);
    expect(f.archive.session("opencode", "b")?.messages[0]).toMatchObject({
      model: "v2-model",
      content: [{ text: "projected" }],
    });
  });
  it("includes OpenCode JSON sidecars in change detection", async () => {
    const f = fixture("opencode");
    write(join(f.source, "storage/session/project/s.json"), {
      id: "s",
      directory: f.workspace,
    });
    write(join(f.source, "storage/message/s/m.json"), {
      id: "m",
      sessionID: "s",
      role: "assistant",
      modelID: "model",
      time: { created: 1000 },
    });
    const part = join(f.source, "storage/part/m/p.json");
    write(part, {
      id: "p",
      sessionID: "s",
      messageID: "m",
      type: "text",
      text: "first",
    });
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
    write(part, {
      id: "p",
      sessionID: "s",
      messageID: "m",
      type: "text",
      text: "next",
    });
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
    expect(
      f.archive.session("opencode", "s")?.messages[0].content,
    ).toMatchObject([{ text: "next" }]);
  });
  it("prefers Cursor JSONL over text and keeps subagent identities separate", async () => {
    const f = fixture("cursor"),
      slug = f.workspace.replace(/^[\\/]+/, "").replace(/[:\\/]+/g, "-");
    const root = join(f.source, slug, "agent-transcripts");
    write(join(root, "main.txt"), "user:\nold text");
    write(
      join(root, "main/main.jsonl"),
      lines(
        { role: "user", message: { content: "current" } },
        {
          role: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Read", input: { path: "a" } }],
          },
        },
      ),
    );
    write(
      join(root, "main/subagents/child.jsonl"),
      lines({ role: "user", message: { content: "child" } }),
    );
    const result = await f.archive.scan(f.workspace, f.sources);
    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({ cursor: 1 });
    expect(f.archive.session("cursor", "main")?.messages[0].content).toBe(
      "current",
    );
    expect(f.archive.session("cursor", "child")?.parentId).toBe("main");
    expect(
      parseCursor(
        "user:\nhello\nassistant:\n[Tool call] Read\n  path: a",
        "s.txt",
        f.workspace,
      ).messages,
    ).toHaveLength(2);
  });
  it("reads Cursor IDE bubbles, omits auth/encryption secrets and detects edits", async () => {
    const f = fixture("cursor-ide"),
      db = new Database(join(f.source, "state.vscdb"));
    cleanup.push(() => db.close());
    db.pragma("journal_mode = WAL");
    db.exec(
      "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE ItemTable (key TEXT,value TEXT)",
    );
    db.prepare(
      "INSERT INTO ItemTable VALUES ('cursorAuth/accessToken','do-not-read')",
    ).run();
    const set = (key: string, value: unknown) =>
      db
        .prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)")
        .run(key, JSON.stringify(value));
    set("composerData:c", {
      workspaceIdentifier: { uri: { fsPath: f.workspace } },
      encryptionKey: "private",
      fullConversationHeadersOnly: [
        { bubbleId: "u", type: 1 },
        { bubbleId: "a", type: 2 },
      ],
    });
    set("bubbleId:c:u", { type: 1, text: "hello" });
    set("bubbleId:c:a", { type: 2, text: "answer" });
    expect((await f.archive.scan(f.workspace, f.sources)).counts).toEqual({
      "cursor-ide": 1,
    });
    const session = f.archive.session("cursor-ide", "c");
    expect(JSON.stringify(session)).not.toMatch(
      /private|encryptionKey|do-not-read/,
    );
    set("bubbleId:c:a", { type: 2, text: "edited" });
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
    db.prepare("DELETE FROM cursorDiskKV WHERE key='bubbleId:c:u'").run();
    const incomplete = await f.archive.scan(f.workspace, f.sources);
    expect(incomplete.errors).toEqual([]);
    expect(incomplete.deferred).toEqual([
      "cursor-ide: Cursor IDE transcript has missing bubbles; previous archive retained",
    ]);
    expect(f.archive.session("cursor-ide", "c")?.messages).toHaveLength(2);
    expect(f.archive.session("cursor-ide", "c")?.messages[1].content).toBe("edited");
    set("bubbleId:c:u", { type: 1, text: "restored" });
    const recovered = await f.archive.scan(f.workspace, f.sources);
    expect(recovered.errors).toEqual([]);
    expect(recovered.deferred).toBeUndefined();
    expect(f.archive.session("cursor-ide", "c")?.messages[0].content).toBe("restored");
  });
  it("deduplicates Gemini JSONL message revisions and differences cumulative input usage", () => {
    const s = parseGemini(
      lines(
        { sessionId: "g" },
        {
          id: "a",
          type: "gemini",
          content: "draft",
          tokens: { input: 10, output: 1 },
        },
        {
          id: "a",
          type: "gemini",
          content: "final",
          tokens: { input: 10, output: 3 },
        },
        {
          id: "b",
          type: "gemini",
          content: "next",
          tokens: { input: 16, output: 2 },
        },
      ),
      "/workspace",
    );
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0].content).toBe("final");
    expect(s.messages[1].usage?.input_tokens).toBe(6);
  });
  it("keeps Codex-compatible product identities separate", async () => {
    const f = fixture("traex");
    write(
      join(f.source, "rollout-a.jsonl"),
      lines(
        { type: "session_meta", payload: { id: "same", cwd: f.workspace } },
        { type: "turn_context", payload: { model: "test-model" } },
        {
          type: "response_item",
          payload: { type: "message", role: "assistant", content: "answer" },
        },
      ),
    );
    const sources = [
      ...f.sources,
      { id: "augure-code", paths: [f.source] },
      { id: "codex", paths: [f.source] },
    ];
    expect((await f.archive.scan(f.workspace, sources)).counts).toEqual({
      traex: 1,
      "augure-code": 1,
      codex: 1,
    });
  });
  it("resolves explicit and user-home source roots", () => {
    const defs = sourceDefinitions("/test-home", {
      DSH_HOME: "/custom",
      CURSOR_IDE_DIR: "/cursor",
      OPENCODE_DIR: "/oc",
    });
    expect(defs.find((s) => s.id === "deepseek-harness")?.paths).toEqual([
      join("/custom", "sessions"),
    ]);
    expect(defs.find((s) => s.id === "opencode")?.paths).toEqual(["/oc"]);
  });
  it("lets a live OpenCode database supersede legacy JSON storage", async () => {
    const f = fixture("opencode");
    write(join(f.source, "storage/session/project/s.json"), {
      id: "s",
      directory: f.workspace,
    });
    write(join(f.source, "storage/message/s/m.json"), {
      id: "m",
      role: "user",
    });
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(1);
    const db = openCode(f);
    db.session("s");
    db.message("new", "s", "database answer");
    const result = await f.archive.scan(f.workspace, f.sources);
    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({ opencode: 1 });
    expect(f.archive.session("opencode", "s")?.messages[0].key).toBe("new");
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(0);
  });
  it.each(["pi", "omp", "omo", "prime-agent", "stepcode"])(
    "reads %s tree messages, models, tools, and known-zero usage",
    async (provider) => {
      const f = fixture(provider);
      write(
        join(f.source, "p.jsonl"),
        lines(
          { type: "title", title: "rewritable slot" },
          { type: "session", id: "p", cwd: f.workspace },
          {
            type: "message",
            id: "u",
            message: { role: "user", content: "inspect" },
          },
          {
            type: "model_change",
            id: "meta",
            parentId: "u",
            modelId: "model-one",
          },
          {
            type: "message",
            id: "a",
            parentId: "meta",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", name: "read", arguments: { path: "a" } },
              ],
              usage: { input: 0, output: 2, cache: { read: 4 } },
            },
          },
          {
            type: "message",
            id: "t",
            parentId: "a",
            message: {
              role: "toolResult",
              toolCallId: "call",
              content: [{ type: "text", text: "result" }],
            },
          },
        ),
      );
      const result = await f.archive.scan(f.workspace, f.sources);
      expect(result.errors).toEqual([]);
      expect(result.counts).toEqual({ [provider]: 1 });
      expect(f.archive.session(provider, "p")?.messages[1]).toMatchObject({
        model: "model-one",
        parentKey: "u",
        usage: {
          input_tokens: 0,
          output_tokens: 2,
          cache_read_input_tokens: 4,
        },
      });
      expect(f.archive.session(provider, "p")?.messages[2].role).toBe("tool");
      expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(0);
    },
  );
  it("distinguishes Pi forks from OMP subagents and resolves parent header IDs", async () => {
    const f = fixture("omp");
    write(
      join(f.source, "parent.jsonl"),
      lines({ type: "session", id: "parent-actual-id", cwd: f.workspace }),
    );
    write(
      join(f.source, "parent/child.jsonl"),
      lines({ type: "session", id: "child", cwd: f.workspace }),
    );
    write(
      join(f.source, "fork.jsonl"),
      lines({
        type: "session",
        id: "fork",
        cwd: f.workspace,
        parentSession: "parent.jsonl",
      }),
    );
    expect((await f.archive.scan(f.workspace, f.sources)).counts).toEqual({
      omp: 2,
    });
    expect(f.archive.session("omp", "child")).toMatchObject({
      parentId: "parent-actual-id",
      relationship: "subagent",
    });
    expect(f.archive.session("omp", "fork")).toMatchObject({
      parentId: "parent-actual-id",
      relationship: "fork",
    });
  });
});

function harness() {
  const rows: Record<string, unknown>[] = [
    { type: "session", version: 0, id: "h", cwd: "/workspace" },
  ];
  let seq = 0;
  const event = (type: string, data: unknown, surface?: unknown) =>
    rows.push({
      type,
      data,
      seq: seq++,
      time: 1800000000000 + seq,
      ...(surface ? { surfaceOp: surface } : {}),
    });
  event("turn/start", { turn: 1 });
  event("step/start", { turn: 1, step: 1 });
  event(
    "user/message",
    {
      role: "user",
      content: [{ type: "text", text: "inspect" }],
      source: { kind: "user" },
    },
    "append",
  );
  event("request/header", { header: { config: { model: "fallback-model" } } });
  event("assistant/chunk", {
    turn: 1,
    step: 1,
    chunk: { type: "text-delta", index: 0, text: "draft" },
  });
  event("assistant/chunk", {
    turn: 1,
    step: 1,
    chunk: { type: "usage", usage: { inputTokens: 20, outputTokens: 2 } },
  });
  return { rows, event };
}
// Reduced from local v3/v4 logs; identities, paths and message text are synthetic.
// User messages are direct, while the other message envelopes are nested.
function recordedHarness(version: 3 | 4) {
  const rows: Record<string, unknown>[] = [
    { type: "session", version, id: "recorded-harness", cwd: "/workspace" },
  ];
  const event = (type: string, data: unknown, surfaceOp?: string) => {
    rows.push({ type, seq: rows.length - 1, time: 1800000000000 + rows.length, data,
      ...(surfaceOp ? { surfaceOp } : {}) });
  };
  const message = (role: string, text: string, source: Record<string, unknown>) =>
    ({ id: `${role}-message`, role, content: [{ type: "text", text }], source });
  event("turn/start", { turn: 1 });
  event("step/start", { turn: 1, step: 1 });
  event("system/message", { turn: 1, step: 1,
    message: message("system", "System instructions", { kind: "system" }) }, "append");
  event("user/message", message("user", "Inspect the project", { kind: "user" }), "append");
  if (version === 4) event("developer/message", { turn: 1, step: 1, headerSeq: 0,
    message: message("developer", "Updated tool instructions", { kind: "developer" }) }, "append");
  event("request/header", { turn: 1, step: 1, header: { config: { model: "example-model" } } });
  event("assistant/message", { turn: 1, step: 1, message: {
    id: "assistant-call", role: "assistant", source: { kind: "model", model: "example-model" },
    content: [{ type: "text", text: "Inspecting" },
      { type: "tool-call", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
  } }, "append");
  event("tool/call", { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: { command: "pwd" } });
  const job = { jobId: "job-1", owner: "agent-1", kind: "bash", label: "pwd",
    startedAt: 1800000000010, toolCall: { callId: "call-1", rootCallId: "call-1" } };
  if (version === 4) {
    event("job/registered", job);
    event("job/settled", { ...job, finishedAt: 1800000000011, status: "completed",
      cause: "completed", producerReported: true, detail: "Command completed" });
  }
  event("tool/result", { turn: 1, step: 1, message: {
    ...message("tool", "/workspace", { kind: "tool", callId: "call-1" }),
    ...(version === 4 ? { toolCallId: "call-1", isError: false } : {}),
  } }, "append");
  event("step/end", { turn: 1, step: 1 });
  event("step/start", { turn: 1, step: 2 });
  event("assistant/message", { turn: 1, step: 2,
    message: message("assistant", "Inspection complete", { kind: "model", model: "example-model" }),
    usage: { inputTokens: 21, outputTokens: 5 } }, "append");
  event("step/end", { turn: 1, step: 2 });
  event("turn/end", { turn: 1 });
  return rows;
}
describe("DeepSeek Harness event reconstruction", () => {
  it.each([3, 4] as const)("reads real-format v%s message envelopes and keeps tool results without duplicate job messages", (version) => {
    const rows = recordedHarness(version);
    const text = lines(...rows);
    const parsed = parseHarness(text);
    expect(parsed.messages.map(m => m.role)).toEqual([
      "system", "user", ...(version === 4 ? ["developer"] : []), "assistant", "tool", "assistant",
    ]);
    expect(parsed.messages.map(m => (m.content as { text?: string }[])[0].text)).toEqual([
      "System instructions", "Inspect the project", ...(version === 4 ? ["Updated tool instructions"] : []),
      "Inspecting", "/workspace", "Inspection complete",
    ]);
    expect(parsed.messages.at(-1)).toMatchObject({ model: "example-model", usage: { outputTokens: 5 } });
    expect(parseHarness(decodeHarness(zstdCompressSync(Buffer.from(text)), true))).toEqual(parsed);
    // Native logs also concatenate compressed frames; keep the same envelopes.
    const bytes = Buffer.from(text), midpoint = Math.floor(bytes.length / 2);
    const frames = Buffer.concat([
      zstdCompressSync(bytes.subarray(0, midpoint)),
      zstdCompressSync(bytes.subarray(midpoint)),
    ]);
    expect(parseHarness(decodeHarness(frames, true))).toEqual(parsed);
  });
  it.each(["system", "developer"])("still rejects missing nested %s content", (role) => {
    const rows = recordedHarness(4);
    const row = rows.find(r => r.type === `${role}/message`)!;
    row.data = { turn: 1, step: 1, message: { role }, content: [{ type: "text", text: "wrong location" }] };
    expect(() => parseHarness(lines(...rows))).toThrow(/message content is missing/);
  });
  it("retries a failed compressed v4 source and checkpoints the complete session", async () => {
    const f = fixture("deepseek-harness");
    const rows = recordedHarness(4);
    rows[0].cwd = f.workspace;
    const path = join(f.source, "session.v4.jsonl.zstd");
    const broken = structuredClone(rows);
    broken.find(r => r.type === "system/message")!.data = { message: {} };
    writeFileSync(path, zstdCompressSync(Buffer.from(lines(...broken))));
    expect((await f.archive.scan(f.workspace, f.sources)).errors).toEqual([
      "deepseek-harness: DeepSeek message content is missing",
    ]);
    expect(f.archive.session("deepseek-harness", "recorded-harness")).toBeUndefined();
    writeFileSync(path, zstdCompressSync(Buffer.from(lines(...rows))));
    const result = await f.archive.scan(f.workspace, f.sources, { sourceProgress: () => {} });
    expect(result.errors).toEqual([]);
    expect(result.counts["deepseek-harness"]).toBe(1);
    expect(result.sourceProgress?.[f.workspace]?.["deepseek-harness"]).toEqual({
      completed: 1, total: 1, status: "done",
    });
    expect(f.archive.session("deepseek-harness", "recorded-harness")?.messages).toHaveLength(6);
    const repeated = await f.archive.scan(f.workspace, f.sources);
    expect(repeated.errors).toEqual([]);
    expect(repeated.updated).toBe(0);
  });
  it("replaces streamed drafts with final content and final usage", () => {
    const { rows, event } = harness();
    expect(parseHarness(lines(...rows)).messages[1]).toMatchObject({
      model: "fallback-model",
      content: [{ text: "draft" }],
    });
    event(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final" }],
          source: { model: "final-model" },
        },
        usage: { inputTokens: 21, outputTokens: 5 },
      },
      "append",
    );
    event("step/end", { turn: 1, step: 1 });
    event("turn/end", { turn: 1 });
    const parsed = parseHarness(lines(...rows));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1]).toMatchObject({
      model: "final-model",
      content: [{ text: "final" }],
      usage: { outputTokens: 5 },
    });
    const compressed = zstdCompressSync(Buffer.from(lines(...rows)));
    expect(parseHarness(decodeHarness(compressed, true))).toEqual(parsed);
  });
  it("expands packed chunks and rejects gaps or unknown required events", () => {
    const { rows } = harness();
    rows.push({
      type: "text-chunks",
      seq0: 6,
      time0: 1800000000010,
      data: { turn: 1, step: 1, index: 0, texts: [" one", " two"], dt: [1] },
    });
    expect(parseHarness(lines(...rows)).messages[1].content).toMatchObject([
      { text: "draft one two" },
    ]);
    expect(() =>
      parseHarness(
        lines(...rows, { type: "future/event", seq: 8, time: 1, data: {} }),
      ),
    ).toThrow(/Unknown required/);
    expect(() =>
      parseHarness(
        lines(...rows, {
          type: "session/title",
          seq: 10,
          time: 1,
          data: { title: "x" },
        }),
      ),
    ).toThrow(/gap/);
  });
  it("excludes inherited messages and does not interpret compaction replacements as new work", () => {
    const { rows, event } = harness();
    rows[0].seedLength = 6;
    rows[0].parentSession = "parent";
    event(
      "user/message",
      { role: "user", content: [{ type: "text", text: "summary" }] },
      { op: "replace", start: 0, end: 5 },
    );
    event(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "owned" }],
          source: { model: "m" },
        },
      },
      "append",
    );
    const s = parseHarness(lines(...rows));
    expect(s.parentId).toBe("parent");
    expect(s.messages).toHaveLength(1);
  });
  it("collects a compressed on-disk source idempotently", async () => {
    const f = fixture("deepseek-harness"),
      { rows } = harness();
    rows[0].cwd = f.workspace;
    writeFileSync(
      join(f.source, "session.jsonl.zstd"),
      zstdCompressSync(Buffer.from(lines(...rows))),
    );
    expect((await f.archive.scan(f.workspace, f.sources)).errors).toEqual([]);
    expect((await f.archive.scan(f.workspace, f.sources)).updated).toBe(0);
  });
});
