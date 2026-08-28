import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractGitOperations } from "./extract.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "adit-git-operations-"));
  tempDirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
  return path;
}

describe("extractGitOperations", () => {
  it("extracts only Codex Git commands from the latest turn", () => {
    const path = transcript([
      { payload: { type: "message", role: "user", content: "old" } },
      { payload: { type: "exec_command_end", call_id: "old-call", command: "git status", cwd: "/repo", status: "completed" } },
      { payload: { type: "message", role: "user", content: "new" } },
      {
        payload: {
          type: "exec_command_end",
          call_id: "new-call",
          command: ["/bin/zsh", "-lc", "git add a.ts && git commit -m fix"],
          cwd: "/repo",
          status: "completed",
          exit_code: 0,
          aggregated_output: "[main abc1234] fix",
        },
      },
    ]);

    expect(extractGitOperations({
      platform: "codex",
      transcriptPath: path,
      defaultCwd: "/fallback",
    })).toEqual([
      expect.objectContaining({ toolCallId: "new-call", operationIndex: 0, operation: "add", cwd: "/repo" }),
      expect.objectContaining({ toolCallId: "new-call", operationIndex: 1, operation: "commit", cwd: "/repo" }),
    ]);
  });

  it("uses Claude Bash tool results for operation status and output", () => {
    const path = transcript([
      { type: "user", sessionId: "claude-1", message: { content: "commit it" } },
      {
        type: "assistant",
        sessionId: "claude-1",
        message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "git commit -m fix" } }] },
      },
      {
        type: "user",
        sessionId: "claude-1",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "[main abc1234] fix" }] },
        toolUseResult: { stdout: "[main abc1234] fix" },
      },
    ]);

    expect(extractGitOperations({
      platform: "claude-code",
      transcriptPath: path,
      expectedSessionId: "claude-1",
      defaultCwd: "/repo",
    })).toEqual([
      expect.objectContaining({ toolCallId: "tool-1", operation: "commit", status: "success" }),
    ]);
  });

  it("extracts Gemini and OpenCode shell tools", () => {
    const geminiPath = transcript([
      { type: "user", sessionId: "gemini-1", content: [{ text: "push" }] },
      { type: "gemini", toolCalls: [{ id: "g-1", name: "run_shell_command", args: { command: "git push" }, status: "success" }] },
    ]);
    const openCodePath = transcript([
      { role: "user", sessionID: "open-1", messageID: "m1", parts: [{ type: "text", text: "inspect" }] },
      {
        role: "assistant",
        sessionID: "open-1",
        messageID: "m2",
        parts: [{ type: "tool", tool: "bash", callID: "o-1", state: { input: { command: "git -C api status" }, status: "completed", output: "clean" } }],
      },
    ]);

    expect(extractGitOperations({ platform: "gemini", transcriptPath: geminiPath, defaultCwd: "/repo" }))
      .toEqual([expect.objectContaining({ toolCallId: "g-1", operation: "push" })]);
    expect(extractGitOperations({ platform: "opencode", transcriptPath: openCodePath, defaultCwd: "/workspace" }))
      .toEqual([expect.objectContaining({ toolCallId: "o-1", operation: "status", cwd: "/workspace/api" })]);
  });

  it("rejects a transcript belonging to a different platform session", () => {
    const path = transcript([
      { type: "user", sessionId: "other-session", content: [{ text: "push" }] },
      { type: "gemini", toolCalls: [{ id: "g-1", name: "run_shell_command", args: { command: "git push" }, status: "success" }] },
    ]);

    expect(extractGitOperations({
      platform: "gemini",
      transcriptPath: path,
      expectedSessionId: "expected-session",
      defaultCwd: "/repo",
    })).toEqual([]);
  });
});
