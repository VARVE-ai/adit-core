import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeTranscriptSync } from "./claude-transcript-sync.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "adit-claude-transcript-"));
}

describe("ClaudeTranscriptSync", () => {
  it("links tool results to the assistant message that created the tool use", () => {
    const dir = tempDir();
    try {
      const transcriptPath = path.join(dir, "session.jsonl");
      const sessionId = "11111111-1111-1111-1111-111111111111";
      const timestamp = new Date(Date.now() + 1000).toISOString();
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "assistant",
            timestamp,
            message: {
              id: "assistant-message-1",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "Read",
                  input: { file_path: "README.md" },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            timestamp,
            message: {
              id: "tool-result-message-1",
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  content: "file contents",
                },
              ],
            },
          }),
          "",
        ].join("\n"),
      );

      const sync = new ClaudeTranscriptSync();
      sync.noteHook({
        eventType: "UserPromptSubmit",
        sessionId,
        body: {
          session_id: sessionId,
          transcript_path: transcriptPath,
        },
      });

      const toolEvents = sync.drainSession(sessionId).filter((event) => event.type === "tool");
      const completed = toolEvents.find((event) => event.payload.status === "completed");
      expect(completed?.payload).toEqual(expect.objectContaining({
        messageId: "assistant-message-1",
        toolUseId: "toolu_1",
        toolName: "Read",
        input: { file_path: "README.md" },
      }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits run.aborted when the user interrupts the local CLI with ESC", () => {
    const dir = tempDir();
    try {
      const transcriptPath = path.join(dir, "session.jsonl");
      const sessionId = "11111111-1111-1111-1111-111111111111";
      const timestamp = new Date(Date.now() + 1000).toISOString();
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "user",
            uuid: "prompt-1",
            timestamp,
            message: {
              role: "user",
              content: "帮我改一下登录页",
            },
          }),
          JSON.stringify({
            type: "user",
            uuid: "interrupt-1",
            timestamp,
            message: {
              role: "user",
              content: "[Request interrupted by user]",
            },
          }),
          "",
        ].join("\n"),
      );

      const sync = new ClaudeTranscriptSync();
      sync.noteHook({
        eventType: "UserPromptSubmit",
        sessionId,
        body: {
          session_id: sessionId,
          transcript_path: transcriptPath,
        },
      });

      const first = sync.drainSession(sessionId);
      const aborted = first.filter((event) => event.type === "run.aborted");
      expect(aborted).toHaveLength(1);
      expect(aborted[0]?.payload).toEqual(expect.objectContaining({
        sessionId,
        message: "Claude run interrupted by user.",
      }));

      const second = sync.drainSession(sessionId);
      expect(second.filter((event) => event.type === "run.aborted")).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits run.aborted when a tool use is interrupted with ESC", () => {
    const dir = tempDir();
    try {
      const transcriptPath = path.join(dir, "session.jsonl");
      const sessionId = "11111111-1111-1111-1111-111111111111";
      const timestamp = new Date(Date.now() + 1000).toISOString();
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "user",
            uuid: "interrupt-tool-1",
            timestamp,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  is_error: true,
                  content: "[Request interrupted by user for tool use]",
                },
              ],
            },
          }),
          "",
        ].join("\n"),
      );

      const sync = new ClaudeTranscriptSync();
      sync.noteHook({
        eventType: "UserPromptSubmit",
        sessionId,
        body: {
          session_id: sessionId,
          transcript_path: transcriptPath,
        },
      });

      const events = sync.drainSession(sessionId);
      expect(events.filter((event) => event.type === "run.aborted")).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not emit run.aborted for ordinary user prompts", () => {
    const dir = tempDir();
    try {
      const transcriptPath = path.join(dir, "session.jsonl");
      const sessionId = "11111111-1111-1111-1111-111111111111";
      const timestamp = new Date(Date.now() + 1000).toISOString();
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "user",
            uuid: "prompt-1",
            timestamp,
            message: {
              role: "user",
              content: "please [Request interrupted by user] — explain what this marker means",
            },
          }),
          "",
        ].join("\n"),
      );

      const sync = new ClaudeTranscriptSync();
      sync.noteHook({
        eventType: "UserPromptSubmit",
        sessionId,
        body: {
          session_id: sessionId,
          transcript_path: transcriptPath,
        },
      });

      const events = sync.drainSession(sessionId);
      expect(events.filter((event) => event.type === "run.aborted")).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the observed runtime model instead of Claude transcript's provider-normalized model", () => {
    const dir = tempDir();
    try {
      const transcriptPath = path.join(dir, "session.jsonl");
      const sessionId = "a325e3e8-a56a-4f37-875b-15e8aab7c921";
      const now = Date.now();
      const observedAt = now;
      const messageAt = new Date(now + 1_000).toISOString();
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "assistant",
            sessionId,
            uuid: "assistant-1",
            timestamp: messageAt,
            message: {
              id: "message-1",
              role: "assistant",
              model: "glm-5.2",
              content: [{ type: "text", text: "OK" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          }),
          "",
        ].join("\n"),
      );

      const sync = new ClaudeTranscriptSync();
      sync.noteHook({
        eventType: "UserPromptSubmit",
        sessionId,
        body: {
          session_id: sessionId,
          transcript_path: transcriptPath,
        },
      });
      sync.noteModel(sessionId, "glm-5.2[1M][1m]", observedAt);

      expect(sync.drainSession(sessionId)).toContainEqual({
        type: "message",
        payload: expect.objectContaining({
          role: "assistant",
          sessionId,
          messageId: "message-1",
          modelId: "glm-5.2[1M][1m]",
          text: "OK",
        }),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fall back to Claude transcript's provider-normalized model", () => {
    const dir = tempDir();
    try {
      const transcriptPath = path.join(dir, "session.jsonl");
      const sessionId = "11111111-1111-1111-1111-111111111111";
      const now = Date.now();
      const messageAt = new Date(now + 1_000).toISOString();
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "assistant",
            sessionId,
            uuid: "assistant-1",
            timestamp: messageAt,
            message: {
              id: "message-1",
              role: "assistant",
              model: "glm-5.2",
              content: [{ type: "text", text: "before switch" }],
            },
          }),
          "",
        ].join("\n"),
      );

      const sync = new ClaudeTranscriptSync();
      sync.noteHook({
        eventType: "UserPromptSubmit",
        sessionId,
        body: {
          session_id: sessionId,
          transcript_path: transcriptPath,
        },
      });
      sync.noteModel(sessionId, "glm-5.2[1M][1m]", now + 10 * 60_000);

      const event = sync.drainSession(sessionId).find((item) => item.type === "message");
      expect(event?.payload).toEqual(expect.objectContaining({
        text: "before switch",
      }));
      expect(event?.payload.modelId).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
