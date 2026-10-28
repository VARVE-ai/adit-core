import { describe, expect, it } from "vitest";
import { parseCodex } from "./codex.js";

const pageKind = "additional_content.codex_apps_open_page";
const pageText = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
const header = { type: "session_meta", payload: { id: "desktop", cwd: "/workspace" } };
const message = (role: string, text: string, kinds?: unknown) => ({
  type: "response_item",
  payload: {
    type: "message", role, content: [{ type: "input_text", text }],
    ...(kinds === undefined ? {} : { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } }),
  },
});
const parse = (...rows: unknown[]) => parseCodex([header, ...rows].map(row => JSON.stringify(row)).join("\n"));

describe("Codex desktop page context", () => {
  it.each([null, "selected-page"])("excludes page state for %s without renumbering real messages", pageId => {
    const page = message("user", `<external_codex_apps_open_page>${JSON.stringify({ page_id: pageId })}</external_codex_apps_open_page>`, [pageKind]);
    const prompt = message("user", "Real question", ["user.text"]);
    const answer = message("assistant", "Real answer");
    const result = parse(page, prompt, answer, page);
    expect(result.messages).toMatchObject([
      { key: "message:1", role: "user", content: prompt.payload.content, raw: prompt },
      { key: "message:2", role: "assistant", content: answer.payload.content, raw: answer },
    ]);
  });

  it.each([
    ["user quotation", "user", ["user.text"]],
    ["older unclassified input", "user", undefined],
    ["empty classification", "user", []],
    ["malformed classification", "user", pageKind],
    ["mixed user content", "user", [pageKind, "user.text"]],
    ["other attached context", "user", ["additional_content.other"]],
    ["assistant explanation", "assistant", [pageKind]],
  ])("preserves %s even when its text is the same marker", (_name, role, kinds) => {
    const row = message(role as string, pageText, kinds);
    expect(parse(row).messages).toMatchObject([{ content: row.payload.content, raw: row }]);
  });

  it("does not let page state interrupt the real reply's usage or completion", () => {
    const result = parse(
      message("user", "Question", ["user.text"]),
      message("assistant", "Answer"),
      message("user", pageText, [pageKind]),
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 20, output_tokens: 5 } } } },
      { type: "event_msg", payload: { type: "task_complete" } },
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({ usage: { input_tokens: 20, output_tokens: 5 }, finalReply: true });
  });

  it("keeps fallback message keys stable when a page record repeats its native ID", () => {
    const page = { ...message("user", pageText, [pageKind]) };
    const withId = { ...page, payload: { ...page.payload, id: "page-state" } };
    expect(parse(withId, withId, message("user", "Question")).messages).toMatchObject([{ key: "message:1" }]);
  });

  it("returns no imported messages for a page-only session", () => {
    expect(parse(message("user", pageText, [pageKind])).messages).toEqual([]);
  });
});
