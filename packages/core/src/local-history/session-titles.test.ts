import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalHistory } from "./archive.js";
import { parseClaude } from "./claude.js";
import { claudeBranches } from "./claude-lineage.js";
import { parseGemini } from "./gemini.js";
import { parseDeepseek } from "./deepseek-tui.js";
import { parseHarness } from "./deepseek-harness.js";
import { parseProjectJSONL } from "./project-jsonl.js";
import { readPi, piProviders } from "./pi.js";
import { readOpenCodeDatabase, readOpenCodeStorage } from "./opencode.js";
import { readCursorIDE } from "./cursor.js";
import { readNativeMessages } from "./native-messages.js";
import { readDatabaseProvider } from "./database-providers.js";
import { readProjectRecords } from "./project-records.js";
import { parseEvener } from "./semantic-jsonl.js";
import { readRuntimeEvents } from "./runtime-events.js";
import { readReviewEvents } from "./review-events.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
function root() {
  const path = mkdtempSync(join(tmpdir(), "adit-titles-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function database(path = ":memory:") {
  const db = new Database(path); cleanup.push(() => db.close()); return db;
}
function fixture(provider: string, directory = "source") {
  const home = root(), source = join(home, directory), db = database();
  mkdirSync(source);
  const archive = new LocalHistory(db), sources = [{ id: provider, paths: [source] }];
  return { home, source, db, archive, scan: () => archive.scan(home, sources) };
}
const user = { type: "user", uuid: "u", sessionId: "s", cwd: "/work", message: { content: "First question" } };

it.each([
  [[{ type: "ai-title", aiTitle: "Old" }, { type: "ai-title", aiTitle: " Generated " }], "Generated"],
  [[{ type: "custom-title", customTitle: "Renamed" }, { type: "ai-title", aiTitle: "Generated" }], "Renamed"],
  [[{ type: "ai-title", aiTitle: "Generated" }, { type: "custom-title", customTitle: 42 }], "Generated"],
  [[{ type: "custom-title", customTitle: "Old" }, { type: "system", content: "<command-name>/rename</command-name><command-args>New</command-args>" }], "New"],
  [[{ type: "ai-title", aiTitle: "Generated" }, { type: "system", content: "<command-name>/rename</command-name><command-args></command-args>" }], ""],
  [[{ ...user, uuid: "quote", message: { content: "<command-name>/rename</command-name><command-args>Quoted</command-args>" } }], ""],
] as const)("reads Claude title metadata without turning it into a prompt (%#)", (events, title) => {
  const rows = [user, ...events];
  expect(parseClaude(lines(...rows), "s.jsonl").metadata?.title).toBe(title);
  expect(claudeBranches(rows, "s.jsonl")[0].metadata?.title).toBe(title);
});

it("retains a native Claude title on every derived branch and prefers Qoder sidecar names", () => {
  const rows = [user, ...["a", "b", "c", "d"].map((id, i) => ({ ...user, uuid: id, parentUuid: i ? ["a", "b", "c"][i - 1] : "u" })),
    { ...user, uuid: "fork", parentUuid: "u" }, { type: "ai-title", aiTitle: "Topic" }];
  const sessions = claudeBranches(rows, "s.jsonl");
  expect(sessions).toHaveLength(2);
  expect(sessions.map(s => s.metadata?.title)).toEqual(["Topic", "Topic"]);
  expect(claudeBranches(rows, "s.jsonl", "qoder", { title: "Sidecar title" }).every(s => s.metadata?.title === "Sidecar title")).toBe(true);
});

it("keeps IcodeMate's compatible title priority separate from native Claude records", async () => {
  const f = fixture("icodemate"), path = join(f.source, "projects/s.jsonl");
  const rows = [{ ...user, cwd: f.home, sessionName: "Compatible name" }];
  write(path, lines(...rows));
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  expect(f.archive.session("icodemate", "s")?.metadata?.title).toBe("Compatible name");
  expect(parseClaude(lines(...rows), path).metadata?.title).toBe("");
  write(path, lines(...rows, { type: "custom-title", customTitle: "Custom" }, { type: "ai-title", aiTitle: "Generated" },
    { type: "system", content: "<command-name>/rename</command-name><command-args>Command</command-args>" }));
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  expect(f.archive.session("icodemate", "s")?.metadata?.title).toBe("Custom");
});

it("reads Gemini summaries from both formats, including updates and explicit clearing", () => {
  const prompt = { type: "user", content: "First question" };
  expect(parseGemini(JSON.stringify({ sessionId: "s", summary: " Summary ", messages: [prompt] }), "/work").metadata?.title).toBe("Summary");
  const rows = [{ sessionId: "s", summary: "Initial" }, prompt, { $set: { summary: "Latest" } }];
  const session = parseGemini(lines(...rows), "/work");
  expect(session.metadata?.title).toBe("Latest"); expect(session.messages).toHaveLength(1);
  expect(parseGemini(lines(...rows, { $set: { summary: " " } }), "/work").metadata?.title).toBe("");
});

it("reads DeepSeek native titles without inserting title control events into the conversation", () => {
  expect(parseDeepseek(JSON.stringify({ metadata: { id: "s", title: "TUI title" }, messages: [] })).metadata?.title).toBe("TUI title");
  const result = parseHarness(lines({ type: "session", version: 1, id: "s", cwd: "/work" },
    { seq: 0, time: 1, type: "session/title", data: { title: "Old" } },
    { seq: 1, time: 2, type: "session/title", data: { title: "Harness title" } }));
  expect(result.metadata?.title).toBe("Harness title"); expect(result.messages).toEqual([]);
});

it.each(piProviders)("reads %s native names and title-slot precedence", async provider => {
  const dir = root(), path = join(dir, "s.jsonl"), header = { type: "session", id: "s", cwd: dir, title: "Initial" };
  const rows = [header, { type: "session_info", name: "Renamed" }, { type: "message", message: { role: "user", content: "First question" } }];
  write(path, lines(...rows));
  expect((await readPi(path, provider, dir))[0].metadata?.title).toBe("Renamed");
  write(path, lines({ type: "title", title: "Current slot" }, ...rows));
  const session = (await readPi(path, provider, dir))[0];
  expect(session.metadata?.title).toBe("Current slot"); expect(session.messages).toHaveLength(1);
});

it("respects Qwen manual names and OpenClaude title precedence", () => {
  const qwen = [ { ...user, message: { role: "user", parts: [{ text: "First question" }] } },
    { type: "system", subtype: "custom_title", systemPayload: { customTitle: "Manual" } },
    { type: "system", subtype: "custom_title", systemPayload: { titleSource: "auto", customTitle: "Generated" } } ];
  const result = parseProjectJSONL(lines(...qwen), "qwen", "s.jsonl");
  expect(result.metadata?.title).toBe("Manual"); expect(result.messages).toHaveLength(1);
  expect(parseProjectJSONL(lines({ ...user, sessionName: "Initial" }, { type: "custom-title", customTitle: "Custom" },
    { type: "ai-title", aiTitle: "Generated" }), "openclaude", "s.jsonl").metadata?.title).toBe("Custom");
});

it.each(["sessions", "archived_sessions"])("refreshes Codex titles from its own %s index, even when transcripts do not change", async directory => {
  const f = fixture("codex", directory), path = join(f.source, "2026/10/22/rollout-s.jsonl"), index = join(f.home, "session_index.jsonl");
  const original = lines({ type: "session_meta", payload: { id: "s", cwd: f.home } },
    { type: "response_item", payload: { id: "prompt", type: "message", role: "user", content: "First question" } });
  write(path, original);
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  const display = () => f.db.prepare("SELECT title,first_prompt FROM adit_history_sessions").get();
  expect(display()).toEqual({ title: null, first_prompt: "First question" });
  // The missing index was checkpointed; its later creation must invalidate that checkpoint.
  write(index, lines({ id: "s", thread_name: "Old" }, { id: "other", thread_name: "Wrong session" }, { id: "s", thread_name: " Summary " }) + '{"unfinished":');
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  expect(display()).toEqual({ title: "Summary", first_prompt: "First question" });
  const messages = f.archive.session("codex", "s")!.messages;
  write(index, lines({ id: "s", thread_name: "Renamed" }));
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  expect(display()).toEqual({ title: "Renamed", first_prompt: "First question" });
  expect(f.archive.session("codex", "s")!.messages).toEqual(messages);
  expect(await f.scan()).toMatchObject({ errors: [], updated: 0 });
  write(index, lines({ id: "s", thread_name: " " }));
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  expect(display()).toEqual({ title: null, first_prompt: "First question" });
  expect(readFileSync(path, "utf8")).toBe(original);
});

it.each(["claude", "codex"])("backfills unchanged %s archives once and preserves local prompt edits", async provider => {
  const f = fixture(provider, "sessions"), path = join(f.source, provider === "codex" ? "rollout-s.jsonl" : "s.jsonl");
  write(path, provider === "codex" ? lines({ type: "session_meta", payload: { id: "s", cwd: f.home } },
    { type: "response_item", payload: { id: "u", type: "message", role: "user", content: "First question" } }) : lines(
    { ...user, cwd: f.home }, { type: "ai-title", aiTitle: "Native title" }));
  if (provider === "codex") write(join(f.home, "session_index.jsonl"), lines({ id: "s", thread_name: "Native title" }));
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  f.db.prepare("UPDATE adit_history_sessions SET title=NULL,metadata_json=json_remove(metadata_json,'$.title')").run();
  const oldVersion = provider === "codex" ? 7 : 5;
  f.db.prepare("UPDATE adit_history_sources SET parser_version=?").run(oldVersion);
  f.db.prepare("UPDATE adit_history_file_checkpoints SET parser_version=?").run(oldVersion);
  f.db.prepare("INSERT INTO adit_history_text_edits VALUES (?,?,?,?,?,?)").run(provider, "s", "u", 0, "Edited question", 1);
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  expect(f.db.prepare("SELECT title,first_prompt FROM adit_history_sessions").get()).toEqual({ title: "Native title", first_prompt: "Edited question" });
  expect(await f.scan()).toMatchObject({ errors: [], updated: 0 });
});

it("backfills titles on identical transcript copies but still rejects conflicting conversation content", async () => {
  const f = fixture("codex", "sessions"), source = join(f.home, "archived_sessions"), path = join(f.source, "rollout-s.jsonl"), duplicate = join(source, "rollout-s.jsonl");
  const rows = [{ type: "session_meta", payload: { id: "s", cwd: f.home } },
    { type: "response_item", payload: { id: "u", type: "message", role: "user", content: "First question" } }];
  write(path, lines(...rows)); write(duplicate, lines(...rows));
  const scan = () => f.archive.scan(f.home, [{ id: "codex", paths: [f.source, source] }]);
  expect(await scan()).toMatchObject({ errors: [], updated: 2 });
  write(join(f.home, "session_index.jsonl"), lines({ id: "s", thread_name: "Native title" }));
  expect(await scan()).toMatchObject({ errors: [], updated: 2 });
  expect(f.archive.session("codex", "s")?.metadata?.title).toBe("Native title");
  write(duplicate, lines(...rows, { type: "response_item", payload: { id: "different", type: "message", role: "user", content: "Conflicting copy" } }));
  expect((await scan()).errors).toEqual([expect.stringContaining("Conflicting copies")]);
  expect(f.archive.session("codex", "s")?.messages).toHaveLength(1);
});

it.each(["extended", "identical", "modified", "shortened", "different-workspace"])("handles a moved Codex transcript (%s) without losing archived evidence", async scenario => {
  const f = fixture("codex", "sessions"), source = join(f.home, "archived_sessions");
  const path = join(f.source, "2026/10/27/rollout-s.jsonl"), moved = join(source, "rollout-s.jsonl");
  const meta = { type: "session_meta", payload: { id: "s", cwd: f.home } };
  const rows = Array.from({length: 123}, (_, i) => ({ type: "response_item", payload: {
    id: `m${i}`, type: "message", role: i % 2 ? "assistant" : "user", content: `Message ${i}`,
  } }));
  write(path, lines(meta, ...rows.slice(0, 78)));
  const scan = () => f.archive.scan(f.home, [{ id: "codex", paths: [f.source, source] }]);
  expect(await scan()).toMatchObject({ errors: [], updated: 1 });
  const original = f.archive.session("codex", "s");
  const oldSources = f.db.prepare("SELECT path FROM adit_history_sources").all();
  const count = scenario === "identical" ? 78 : scenario === "shortened" ? 77 : 123;
  const incoming = rows.slice(0, count);
  if (scenario === "modified") incoming[0] = {...incoming[0], payload: {...incoming[0].payload, content: "Changed"}};
  write(moved, lines(scenario === "different-workspace" ? {...meta, payload: {...meta.payload, cwd: source}} : meta, ...incoming));
  rmSync(path);
  const result = await scan();
  if (scenario === "extended" || scenario === "identical") {
    expect(result).toMatchObject({ errors: [], updated: 1 });
    expect(f.archive.session("codex", "s")?.messages).toHaveLength(count);
    expect(f.archive.session("codex", "s")?.messages.slice(0, 78)).toEqual(original?.messages);
    const sources = f.db.prepare("SELECT path FROM adit_history_sources").all();
    expect(sources).toHaveLength(1);
    expect(sources).not.toEqual(oldSources);
    expect(await scan()).toMatchObject({ errors: [], updated: 0 });
  } else {
    expect(result.errors).toEqual([expect.stringContaining("Conflicting copies")]);
    expect(f.archive.session("codex", "s")).toEqual(original);
    expect(f.db.prepare("SELECT path FROM adit_history_sources").all()).toEqual(oldSources);
  }
});

it.each(["commandcode", "copilot", "kimi", "kimi-work"])("updates %s from its title companion while retaining the first prompt", async provider => {
  const f = fixture(provider);
  const path = provider === "commandcode" ? join(f.source, "s.jsonl") : provider === "copilot" ? join(f.source, "session-state/s/events.jsonl") : join(f.source, "work/conv-s/wire.jsonl");
  const titlePath = provider === "commandcode" ? path.replace(".jsonl", ".meta.json") : join(dirname(path), provider === "copilot" ? "workspace.yaml" : "state.json");
  const update = (title: string) => write(titlePath, provider === "commandcode" ? { cwd: f.home, title } : provider === "copilot" ? `name: ${title}\nuser_named: false\n` : { custom_title: title });
  write(path, provider === "commandcode" ? lines({ role: "user", content: "First question" }) : provider === "copilot" ? lines(
    { type: "session.start", data: { sessionId: "s", context: { cwd: f.home } } }, { type: "user.message", data: { content: "First question" } }) : lines(
    { type: "config.update", cwd: f.home }, { type: "TurnBegin", input: "First question" }));
  update("Initial");
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  update("Renamed");
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  expect(f.db.prepare("SELECT title,first_prompt FROM adit_history_sessions").get()).toEqual({ title: "Renamed", first_prompt: "First question" });
  expect(await f.scan()).toMatchObject({ errors: [], updated: 0 });
});

it.each(["opencode", "kilo", "mimocode", "icodemate"])("reads %s titles from SQLite and JSON storage, ignoring native placeholders", async provider => {
  const dir = root(), path = join(dir, `${provider}.db`), db = database(path);
  db.exec("CREATE TABLE session(id TEXT, directory TEXT, title TEXT)");
  db.prepare("INSERT INTO session VALUES ('s',?,?)").run(dir, "Native title");
  expect(readOpenCodeDatabase(path, provider, dir)[0].metadata?.title).toBe("Native title");
  db.prepare("UPDATE session SET title=?").run("New session - 2026-03-22T10:00:00.000Z");
  expect(readOpenCodeDatabase(path, provider, dir)[0].metadata?.title).toBe("");
  const json = join(dir, "storage/session/project/s.json");
  write(json, { id: "s", directory: dir, title: "JSON title" });
  expect((await readOpenCodeStorage(json, provider, dir))[0].metadata?.title).toBe("JSON title");
});

it("reads only the Cursor composer name, leaving unrelated private metadata out", () => {
  const dir = root(), db = database(join(dir, "state.vscdb"));
  db.exec("CREATE TABLE cursorDiskKV(key TEXT, value TEXT)");
  const put = db.prepare("INSERT INTO cursorDiskKV VALUES (?,?)");
  put.run("composerData:s", JSON.stringify({ name: "Composer title", encryptionKey: "do-not-archive", trackedGitRepos: [{ repoPath: dir }], fullConversationHeadersOnly: [{ bubbleId: "u", type: 1 }] }));
  put.run("bubbleId:s:u", JSON.stringify({ type: 1, text: "First question" }));
  const [session] = readCursorIDE(join(dir, "state.vscdb"), dir);
  expect(session.metadata?.title).toBe("Composer title"); expect(JSON.stringify(session)).not.toContain("do-not-archive");
});

it.each(["openclaw", "qclaw"])("reads %s manual labels before generated names", async provider => {
  const dir = root(), path = join(dir, "openclaw-agent.sqlite"), db = database(path);
  db.exec("CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT); CREATE TABLE session_windows(session_id TEXT,session_key TEXT); CREATE TABLE session_nodes(session_key TEXT,label TEXT,display_name TEXT)");
  db.prepare("INSERT INTO transcript_events VALUES ('s',0,?)").run(JSON.stringify({ type: "session", id: "s" }));
  db.exec("INSERT INTO session_windows VALUES ('s','key'); INSERT INTO session_nodes VALUES ('key','Manual','Generated')");
  expect((await readNativeMessages(path, provider))[0].metadata?.title).toBe("Manual");
  db.exec("UPDATE session_nodes SET label=' '");
  expect((await readNativeMessages(path, provider))[0].metadata?.title).toBe("Generated");
});

it("reads Goose's description fallback and Evener's native name", () => {
  const dir = root(), path = join(dir, "sessions.db"), db = database(path);
  db.exec("CREATE TABLE sessions(id TEXT,working_dir TEXT,name TEXT,description TEXT); CREATE TABLE messages(session_id TEXT,role TEXT,content_json TEXT)");
  db.prepare("INSERT INTO sessions VALUES ('s',?,' ','Generated description')").run(dir);
  expect(readDatabaseProvider(path, "goose")[0].metadata?.title).toBe("Generated description");
  expect(parseEvener([{ format_version: 2, session_id: "s", working_dir: dir }], "s.transcript.jsonl", { name: "Evener name" }).metadata?.title).toBe("Evener name");
});

it("ignores Muse's random automatic handles but collects chosen names and Junie title events", async () => {
  const dir = root(), muse = join(dir, "muse/session.jsonl"), automatic = { payload_type: "session.name.changed", payload: { source: "automatic", new_name: "quiet-lyra" } };
  write(muse, lines(automatic));
  expect((await readRuntimeEvents(muse, "muse"))[0].metadata?.title).toBe("");
  write(muse, lines({ payload_type: "session.name.changed", payload: { source: "user", new_name: "Chosen name" } }, automatic));
  expect((await readRuntimeEvents(muse, "muse"))[0].metadata?.title).toBe("Chosen name");
  const junie = join(dir, "junie/events.jsonl");
  write(junie, lines({ kind: "SessionTitleSetEvent", name: "Junie title" }, { kind: "UserPromptEvent", requestId: "u", prompt: "First question" }));
  expect((await readReviewEvents(junie, "junie"))[0].metadata?.title).toBe("Junie title");
});

it("matches CodeBuddy workspace titles by session ID and ignores Cortex placeholder titles", async () => {
  const dir = root(), path = join(dir, "history/work/s/index.json");
  write(path, { messages: [] });
  write(join(dirname(dirname(path)), "index.json"), { conversations: [{ id: "other", name: "Wrong" }, { id: "s", name: "Native name" }] });
  expect((await readProjectRecords(path, "codebuddy"))[0].metadata?.title).toBe("Native name");
  const cortex = join(dir, "s.json");
  write(cortex, { session_id: "s", title: "Chat for session: s", history: [] });
  expect((await readProjectRecords(cortex, "cortex"))[0].metadata?.title).toBe("");
});

it("collects CodeBuddy manifests while treating the workspace title index as a companion", async () => {
  const f = fixture("codebuddy"), path = join(f.source, "history/work/s/index.json"), titlePath = join(dirname(dirname(path)), "index.json");
  write(path, { messages: [] });
  write(titlePath, { conversations: [{ id: "s", name: "Initial" }] });
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1, scanned: 1 });
  write(titlePath, { conversations: [{ id: "s", name: "Renamed" }] });
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1, scanned: 1 });
  expect(f.archive.session("codebuddy", "work:s")?.metadata?.title).toBe("Renamed");
});

it("refreshes Antigravity titles from committed WAL changes in its separate summary store", async () => {
  const f = fixture("antigravity"), path = join(f.source, "conversations/s.trajectory.json");
  write(path, { steps: [{ userInput: { text: "First question" }, runCommand: { cwd: f.home } }] });
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  const titles = database(join(f.source, "conversation_summaries.db"));
  titles.pragma("journal_mode=WAL"); titles.pragma("wal_autocheckpoint=0");
  titles.exec("CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT); INSERT INTO conversation_summaries VALUES ('s','Native title')");
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  expect(f.archive.session("antigravity", "s")?.metadata?.title).toBe("Native title");
  titles.exec("UPDATE conversation_summaries SET title='Renamed'");
  expect(await f.scan()).toMatchObject({ errors: [], updated: 1 });
  expect(f.archive.session("antigravity", "s")?.metadata?.title).toBe("Renamed");
  expect(await f.scan()).toMatchObject({ errors: [], updated: 0 });
});
