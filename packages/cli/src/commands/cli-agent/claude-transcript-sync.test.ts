import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeTranscriptSync } from "./claude-transcript-sync.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "adit-claude-transcript-"));
}

describe("ClaudeTranscriptSync", () => {
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
        eventType: "SessionStart",
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
        eventType: "SessionStart",
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
