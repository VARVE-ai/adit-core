import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { createHistorySchema } from "./schema.js";
import { StructuredHistory } from "./structured-store.js";
import { historyBlockDataSql } from "./block-data.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture(content: unknown) {
  const database = new Database(":memory:");
  databases.push(database);
  createHistorySchema(database);
  new StructuredHistory(database).write({ provider: "claude", id: "session", cwd: "/fixture", messages: [
    { key: "message", role: "user", content, raw: {} },
  ] });
  const read = () => database.prepare(`SELECT ${historyBlockDataSql()} AS data_json FROM adit_history_blocks b
    JOIN adit_history_messages m ON m.id=b.message_id ORDER BY b.block_index`).all() as { data_json: string | null }[];
  return { database, read };
}

it.each([
  undefined, null, "", "中文\r\nquoted \"text\" 😀", false, 42,
  { type: "text", text: "message", unknown: { retained: true } },
  [{ type: "text", text: "first" }, { type: "image", source: { data: "fixture-image" } },
    { type: "tool_result", content: [{ type: "text", text: "output" }] }, null, ["nested", false]],
  [],
].map(content => ({ content })))("reconstructs block JSON without storing a second copy: $content", ({ content }) => {
  const { database, read } = fixture(content);
  const blocks = Array.isArray(content) ? content : [content];
  expect(read()).toEqual(blocks.map(block => ({ data_json: block === undefined ? null : JSON.stringify(block) })));
  expect(database.prepare("SELECT count(*) count FROM adit_history_blocks WHERE data_json IS NOT NULL").get()).toEqual({ count: 0 });
});

it("preserves unmatched legacy blocks and safely handles missing or malformed message JSON", () => {
  const { database, read } = fixture("canonical");
  database.prepare("UPDATE adit_history_blocks SET data_json=?").run(JSON.stringify({ unique: "legacy" }));
  expect(read()).toEqual([{ data_json: '{"unique":"legacy"}' }]);
  database.prepare("UPDATE adit_history_messages SET content_json=?").run("not JSON");
  expect(read()).toEqual([{ data_json: '{"unique":"legacy"}' }]);
  database.exec("UPDATE adit_history_blocks SET data_json=NULL");
  expect(read()).toEqual([{ data_json: null }]);
  database.prepare("UPDATE adit_history_messages SET content_json=?").run('"scalar"');
  database.exec("UPDATE adit_history_blocks SET block_index=1");
  expect(read()).toEqual([{ data_json: null }]);
  expect(() => historyBlockDataSql("invalid alias")).toThrow("Invalid block data alias");
});
