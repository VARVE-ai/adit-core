import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalHistory } from "./archive.js";
import { StructuredHistory } from "./structured-store.js";
import { SourceCheckpoints, sourceStamp } from "./source-checkpoints.js";
import type { HistorySession } from "./types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const pageText = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
const message = (role: string, text: string, page = false) => ({
  type: "response_item",
  payload: {
    type: "message", role, content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: [page ? "additional_content.codex_apps_open_page" : "user.text"],
    },
  },
});

it.each(["fresh", "upgrade", "upgrade with local edits"])("excludes page events from the %s archive and its summaries", async mode => {
  const root = mkdtempSync(join(tmpdir(), "adit-codex-context-"));
  roots.push(root);
  const path = join(root, "rollout-desktop.jsonl");
  const rows = [
    message("user", pageText, true),
    message("user", "First question"),
    message("assistant", "First answer"),
    message("user", pageText, true),
    message("user", "Second question"),
    message("assistant", "Second answer"),
  ];
  const text = [{ type: "session_meta", payload: { id: "desktop", cwd: root } }, ...rows]
    .map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(path, text);
  const db = new Database(":memory:");
  try {
    const history = new LocalHistory(db), sources = [{ id: "codex", paths: [root] }];
    if (mode !== "fresh") {
      // Reproduce version 6's stored transcript and unchanged-file checkpoint.
      const legacy: HistorySession = {
        id: "desktop", provider: "codex", cwd: root,
        metadata: { nativeContextVersion: 1, turnIds: [] },
        messages: rows.map((row, index) => ({
          key: `message:${index}`, role: row.payload.role, content: row.payload.content, raw: row,
        })),
      };
      new StructuredHistory(db).write(legacy);
      db.prepare("INSERT INTO adit_history_sources VALUES (?,?,?,?,?)").run(
        "codex", `${path}#desktop`, "desktop", createHash("sha256").update(JSON.stringify(legacy)).digest("hex"), 6,
      );
      new SourceCheckpoints(db).save("codex", path, JSON.stringify([root, [root]]), 6, [[path, sourceStamp(path)]], [["codex", "desktop"]]);
      expect(db.prepare("SELECT first_prompt,user_prompt_count FROM adit_history_sessions").get())
        .toEqual({ first_prompt: pageText, user_prompt_count: 4 });
    }
    const edited = mode === "upgrade with local edits";
    if (edited) {
      db.prepare("INSERT INTO adit_history_text_edits VALUES (?,?,?,?,?,?)")
        .run("codex", "desktop", "message:1", 0, "Edited question", 1);
      db.prepare("INSERT INTO adit_history_deleted_turns VALUES (?,?,?,?)")
        .run("codex", "desktop", "message:4", 1);
    }
    expect(await new LocalHistory(db).scan(root, sources)).toMatchObject({ errors: [], updated: 1 });
    expect(history.session("codex", "desktop")?.messages.map(m => m.key))
      .toEqual(edited ? ["message:1", "message:2"] : ["message:1", "message:2", "message:4", "message:5"]);
    expect(db.prepare("SELECT first_prompt,message_count,user_prompt_count FROM adit_history_sessions").get()).toEqual({
      first_prompt: edited ? "Edited question" : "First question",
      message_count: edited ? 2 : 4, user_prompt_count: edited ? 1 : 2,
    });
    expect(db.prepare("SELECT count(*) n FROM adit_history_turns").get()).toEqual({ n: edited ? 1 : 2 });
    expect(db.prepare("SELECT count(*) n FROM adit_history_messages WHERE raw_json LIKE '%additional_content.codex_apps_open_page%'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT parser_version FROM adit_history_sources").get()).toEqual({ parser_version: 7 });
    expect(await new LocalHistory(db).scan(root, sources)).toMatchObject({ errors: [], updated: 0 });
    expect(readFileSync(path, "utf8")).toBe(text);
  } finally { db.close(); }
});
