import { afterEach, describe, expect, it } from "vitest";
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
