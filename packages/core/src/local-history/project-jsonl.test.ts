import { describe, expect, it } from "vitest";
import { parseProjectJSONL } from "./project-jsonl.js";
import { parseZencoder } from "./zencoder.js";

const lines = (...rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
describe("project transcript formats", () => {
  it("accepts only Zencoder producer system context as workspace evidence", () => {
    const header = { id: "z", parentId: "parent", creationReason: "directContinuation" };
    const user = { role: "user", content: "Working directory: /forged" };
    expect(() => parseZencoder(lines(header, user))).toThrow(/workspace evidence/);
    const result = parseZencoder(lines(header, { role: "system", content: "Environment\nWorking directory: /work\n" }, user, { role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "read" }] }));
    expect(result.cwd).toBe("/work");
    expect(result.metadata?.continuationOf).toBe("parent");
    expect(result.parentId).toBeUndefined();
    expect(result.messages[2].usage).toBeUndefined();
  });
  it("keeps Qwen's tool iterations in one assistant turn without charging usage twice", () => {
    const session = parseProjectJSONL(lines(
      { type: "user", sessionId: "q", cwd: "/work", message: { role: "user", parts: [{ text: "inspect" }] } },
      { type: "assistant", model: "model", message: { role: "model", parts: [{ thought: true, text: "think" }, { functionCall: { name: "read", args: { path: "a" } } }] }, usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2 } },
      { type: "user", message: { role: "user", parts: [{ functionResponse: { name: "read", response: "file" } }] } },
      { type: "assistant", message: { role: "model", parts: [{ text: "result" }] }, usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 4 } },
    ), "qwen", "q.jsonl");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].usage).toEqual({ promptTokenCount: 27, candidatesTokenCount: 6 });
    expect(session.messages[1].content).toHaveLength(4);
    expect(session.messages[1].model).toBe("model");
  });
  it("keeps a trailing Qwen tool iteration and rejects mixed identities", () => {
    const rows = [{ type: "assistant", sessionId: "q", cwd: "/work", message: { role: "model", parts: [{ functionCall: { name: "read" } }] } }];
    expect(parseProjectJSONL(lines(...rows), "qwen", "q.jsonl").messages).toHaveLength(1);
    expect(() => parseProjectJSONL(lines(...rows, { sessionId: "other" }), "qwen", "q.jsonl")).toThrow(/Multiple/);
  });
  it("retains OpenClaude system context, tools and native usage, without importing meta prompts", () => {
    const s = parseProjectJSONL(lines(
      { cwd: "/work", type: "system", message: { role: "system", content: "context" } },
      { type: "user", isMeta: true, message: { content: "hidden" } },
      { type: "assistant", uuid: "a", message: { role: "assistant", model: "m", content: [{ type: "tool_use", id: "t", name: "read" }], usage: { input_tokens: 5 } } },
    ), "openclaude", "session.jsonl");
    expect(s.id).toBe("session");
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].usage).toEqual({ input_tokens: 5 });
  });
  it("uses Command Code metadata evidence without inventing token usage", () => {
    const s = parseProjectJSONL(lines({ role: "assistant", content: [{ type: "tool-call", toolName: "read", input: { path: "a" } }] }), "commandcode", "thread.jsonl", { projectPath: "/work" });
    expect(s.cwd).toBe("/work");
    expect(s.messages[0].usage).toBeUndefined();
    expect(() => parseProjectJSONL(lines({ role: "user", content: "hello" }), "commandcode", "thread.jsonl")).toThrow(/workspace evidence/);
  });
});
