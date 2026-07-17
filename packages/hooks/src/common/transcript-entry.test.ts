import { describe, it, expect } from "vitest";
import {
  transcriptEntryRole,
  assistantTextFromTranscriptEntry,
} from "./transcript-entry.js";

describe("transcriptEntryRole", () => {
  it("reads the top-level role shape (Cursor IDE transcripts)", () => {
    expect(transcriptEntryRole({ role: "assistant", message: { content: [] } })).toBe("assistant");
    expect(transcriptEntryRole({ role: "user", message: { content: "hi" } })).toBe("user");
  });

  it("reads the top-level type shape (Claude Code / Cursor CLI stream-json)", () => {
    expect(
      transcriptEntryRole({ type: "assistant", message: { role: "assistant", content: [] } }),
    ).toBe("assistant");
    expect(transcriptEntryRole({ type: "user", message: { role: "user" } })).toBe("user");
  });

  it("falls back to message.role for other type values", () => {
    expect(transcriptEntryRole({ type: "human", message: { role: "user" } })).toBe("user");
  });

  it("does not misclassify gemini or codex line shapes", () => {
    // Gemini chat recording: type is "gemini"/"user" but no message wrapper
    expect(transcriptEntryRole({ type: "gemini", content: [] } as never)).toBeUndefined();
    // Codex rollout: {type: "response_item", payload: {...}}
    expect(
      transcriptEntryRole({ type: "response_item", payload: { role: "assistant" } } as never),
    ).toBeUndefined();
  });
});

describe("assistantTextFromTranscriptEntry", () => {
  it("joins text blocks from an assistant entry in either shape", () => {
    expect(
      assistantTextFromTranscriptEntry({
        role: "assistant",
        message: { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
      }),
    ).toBe("one\ntwo");

    expect(
      assistantTextFromTranscriptEntry({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1" }, { type: "text", text: "answer" }],
        },
      }),
    ).toBe("answer");
  });

  it("reads OpenCode plugin transcript lines (top-level role + parts)", () => {
    expect(
      assistantTextFromTranscriptEntry({
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "thinking…" },
          { type: "text", text: "OpenCode reply" },
          { type: "tool", tool: "bash" },
        ],
      }),
    ).toBe("OpenCode reply");
    // user lines with parts stay excluded
    expect(
      assistantTextFromTranscriptEntry({
        role: "user",
        parts: [{ type: "text", text: "question" }],
      }),
    ).toBeUndefined();
    // message.content wins when both exist
    expect(
      assistantTextFromTranscriptEntry({
        role: "assistant",
        message: { content: [{ type: "text", text: "from message" }] },
        parts: [{ type: "text", text: "from parts" }],
      }),
    ).toBe("from message");
  });

  it("returns undefined for non-assistant entries and empty text", () => {
    expect(
      assistantTextFromTranscriptEntry({ role: "user", message: { content: [{ type: "text", text: "q" }] } }),
    ).toBeUndefined();
    expect(
      assistantTextFromTranscriptEntry({ role: "assistant", message: { content: [{ type: "text", text: "   " }] } }),
    ).toBeUndefined();
    expect(
      assistantTextFromTranscriptEntry({ role: "assistant", message: { content: "plain string" } }),
    ).toBeUndefined();
  });
});
