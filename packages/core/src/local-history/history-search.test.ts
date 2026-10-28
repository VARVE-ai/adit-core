import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalStore } from "../local-state.js";
import { createHistorySchema } from "./schema.js";
import { StructuredHistory } from "./structured-store.js";
import { LocalSessionBrowser } from "./session-browser.js";
import { redactSecrets } from "./secret-detector.js";

const resources: { root: string; store: LocalStore }[] = [];
afterEach(() => {
  for (const { root, store } of resources.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adit-body-search-"));
  const store = new LocalStore(join(root, "state"));
  resources.push({ root, store });
  createHistorySchema(store.db);
  const workspace = store.saveWorkspace({ path: root, providers: ["claude", "codex"], repositories: [] });
  const history = new StructuredHistory(store.db), browser = new LocalSessionBrowser(store.db);
  const write = (id: string, body: string, provider = "claude", cwd = root, date = "2026-10-22T10:00:00Z") => history.write({
    id, provider, cwd, messages: [
      { key: "p", role: "user", content: "Question", timestamp: date, raw: {} },
      { key: "a", role: "assistant", content: body, timestamp: date, raw: {} },
    ],
  });
  return { root, store, history, workspace, browser, write };
}

it("removes legacy search copies and triggers while preserving original history and SQL search", () => {
  const { store, history, workspace, browser, write } = fixture();
  write("kept", "原始正文 remains searchable");
  const before = history.read("claude", "kept");
  store.db.exec(`CREATE VIRTUAL TABLE adit_history_text_fts USING fts5(text_content, block_id UNINDEXED, message_id UNINDEXED, tokenize='trigram');
    INSERT INTO adit_history_text_fts(rowid,text_content,block_id,message_id) SELECT rowid,text_content,id,message_id FROM adit_history_blocks;
    CREATE TRIGGER adit_history_blocks_insert AFTER INSERT ON adit_history_blocks BEGIN
      INSERT INTO adit_history_text_fts(rowid,text_content,block_id,message_id) VALUES(NEW.rowid,NEW.text_content,NEW.id,NEW.message_id); END;`);
  createHistorySchema(store.db);
  createHistorySchema(store.db);
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'adit_history_text_fts%' OR name='adit_history_blocks_insert'").all()).toEqual([]);
  expect(history.read("claude", "kept")).toEqual(before);
  expect(browser.list(workspace, { query: "原始" }).items.map(s => s.id)).toEqual(["kept"]);
  write("new", "newly collected text");
  expect(browser.list(workspace, { query: "newly" }).total).toBe(1);
  expect(store.db.pragma("foreign_key_check")).toEqual([]);
});

it("searches short Chinese words and literal wildcard characters on a read-only connection", () => {
  const { store, workspace, write } = fixture();
  write("text", "登录修复 100% done a_b C:\\work Quote\"AndCase");
  const db = new Database(store.dbPath, { readonly: true });
  try {
    const browser = new LocalSessionBrowser(db);
    for (const query of ["登", "登录", "%", "a_b", "C:\\work", 'quote"andcase'])
      expect(browser.list(workspace, { query }).items.map(s => s.id)).toEqual(["text"]);
    expect(browser.list(workspace, { query: "aXb" }).total).toBe(0);
  } finally { db.close(); }
});

it("does not inspect out-of-project, unselected-provider or out-of-period bodies", () => {
  const { root, store, workspace, browser, write } = fixture();
  write("visible", "allowed needle");
  write("outside", "blocked needle", "claude", root + "-other");
  write("provider", "blocked needle", "codex");
  write("old", "blocked needle", "claude", root, "2026-10-01T00:00:00Z");
  store.db.function("adit_history_redact", (body: unknown) => {
    if (typeof body !== "string") return null;
    if (body.includes("blocked")) throw new Error("Read outside search filters");
    return redactSecrets(body);
  });
  expect(browser.list(workspace, { query: "needle", provider: "claude", from: Date.parse("2026-10-20") }).items.map(s => s.id)).toEqual(["visible"]);
});

it("matches visible masked text while keeping raw secret values out of search results", () => {
  const { workspace, browser, history, write } = fixture();
  const secret = "sk-ant-" + createHash("sha256").update("body-search-fixture").digest("hex");
  write("secret", `Configuration ${secret}`);
  expect(browser.list(workspace, { query: secret }).total).toBe(0);
  const result = browser.list(workspace, { query: "Configuration" });
  expect(result.total).toBe(1);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(browser.list(workspace, { query: "•••" }).total).toBe(1);
  expect(JSON.stringify(history.read("claude", "secret"))).toContain(secret);
});
