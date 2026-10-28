import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { LocalHistory } from "./archive.js";
import { StructuredHistory } from "./structured-store.js";
import type { HistorySession } from "./types.js";

let db: Database.Database;
afterEach(() => db?.close());
const injected =
  "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nFollow the prototype.\n</INSTRUCTIONS>";
const environment =
  "<environment_context><cwd>D:/work</cwd></environment_context>";
const request = "按原型实现页面，包括文案";

function fixture() {
  db = new Database(":memory:");
  new LocalHistory(db);
  return new StructuredHistory(db);
}

function session(id = "s"): HistorySession {
  return {
    id,
    provider: "codex",
    cwd: "D:/work",
    messages: [
      {
        key: "context",
        role: "user",
        content: [{ type: "input_text", text: injected + environment }],
        raw: { context: true },
      },
      { key: "blank", role: "user", content: "\n", raw: {} },
      {
        key: "image",
        role: "user",
        content: [{ type: "input_image", image_url: "data:example" }],
        raw: {},
      },
      {
        key: "request",
        role: "user",
        content: [{ type: "input_text", text: request }],
        raw: {},
      },
      {
        key: "answer",
        role: "assistant",
        content: "done",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 10,
        },
        raw: {},
      },
    ],
  };
}

it("collects the first meaningful user request and preserves native titles and transcript content", () => {
  const store = fixture(),
    original = session();
  original.metadata = { title: "My custom session title" };
  store.write(original);
  expect(
    db.prepare("SELECT title,first_prompt FROM adit_history_sessions").get(),
  ).toEqual({
    title: "My custom session title",
    first_prompt: request,
  });
  expect(store.read("codex", "s")).toEqual(original);
});

it("refreshes old labels on archive startup without rewriting transcripts, usage or transcript revisions", () => {
  const store = fixture(),
    original = session();
  store.write(original);
  store.write({
    ...session("environment"),
    messages: [
      { key: "environment", role: "user", content: environment, raw: {} },
      ...original.messages.slice(3),
    ],
  });
  store.write({
    ...session("no-request"),
    messages: original.messages.slice(0, 3),
  });
  store.write({ ...session("valid"), metadata: { title: "Native title" } });
  db.prepare(
    "UPDATE adit_history_sessions SET first_prompt=? WHERE id IN ('s','no-request')",
  ).run(injected.slice(0, 240));
  db.prepare(
    "UPDATE adit_history_sessions SET first_prompt=? WHERE id='environment'",
  ).run(environment);

  const evidence = () =>
    JSON.stringify([
      db
        .prepare(
          "SELECT provider,id,title,transcript_revision,message_count,user_prompt_count FROM adit_history_sessions ORDER BY id",
        )
        .all(),
      ...["messages", "blocks", "turns", "usage_entries"].map((table) =>
        db.prepare(`SELECT * FROM adit_history_${table} ORDER BY id`).all(),
      ),
    ]);
  const before = evidence();
  new LocalHistory(db);
  expect(
    db
      .prepare("SELECT id,first_prompt FROM adit_history_sessions ORDER BY id")
      .all(),
  ).toEqual([
    { id: "environment", first_prompt: request },
    { id: "no-request", first_prompt: null },
    { id: "s", first_prompt: request },
    { id: "valid", first_prompt: request },
  ]);
  expect(evidence()).toBe(before);
  expect(store.read("codex", "s")).toEqual(original);
  const changes = db.prepare("SELECT total_changes() n").get();
  expect(store.refreshCodexPromptSummaries()).toBe(0);
  expect(db.prepare("SELECT total_changes() n").get()).toEqual(changes);
});
