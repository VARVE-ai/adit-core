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

  it("extracts Codex desktop exec custom tool calls and pairs their output", () => {
    const path = transcript([
      { type: "session_meta", payload: { session_id: "codex-desktop-1" } },
      { type: "response_item", payload: { type: "message", role: "user", content: "commit it" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-commit",
          name: "exec",
          input: 'const r = await tools.exec_command({cmd:"git commit -m \\"fix: save work\\"",workdir:"/repo",yield_time_ms:30000,max_output_tokens:6000}); text(r.output);',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-commit",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.3 seconds\nOutput:\n" },
            { type: "input_text", text: "[main abc1234] fix: save work\n" },
          ],
        },
      },
    ]);

    expect(extractGitOperations({
      platform: "codex",
      transcriptPath: path,
      expectedSessionId: "codex-desktop-1",
      defaultCwd: "/fallback",
    })).toEqual([
      expect.objectContaining({
        toolCallId: "call-commit",
        operation: "commit",
        status: "success",
        cwd: "/repo",
        output: "[main abc1234] fix: save work",
        commitMessage: "fix: save work",
      }),
    ]);
  });

  it("unwraps yielded Codex desktop exec command results", () => {
    const path = transcript([
      { type: "session_meta", payload: { session_id: "codex-desktop-1" } },
      { type: "response_item", payload: { type: "message", role: "user", content: "commit it" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-commit",
          name: "exec",
          input: 'const r = await tools.exec_command({cmd:"git commit -m \\"Improve comparison\\" && git push",workdir:"/repo",yield_time_ms:1000,max_output_tokens:6000}); text(JSON.stringify(r));',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-commit",
          output: [
            { type: "input_text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
            {
              type: "input_text",
              text: JSON.stringify({
                chunk_id: "chunk-1",
                wall_time_seconds: 1.002,
                session_id: 123,
                output: "[bugfix/adit-core-bugs 7282e07] Improve comparison\n 2 files changed\n",
              }),
            },
          ],
        },
      },
    ]);

    expect(extractGitOperations({
      platform: "codex",
      transcriptPath: path,
      expectedSessionId: "codex-desktop-1",
      defaultCwd: "/fallback",
    })).toEqual([
      expect.objectContaining({
        toolCallId: "call-commit",
        operation: "commit",
        status: "success",
        cwd: "/repo",
        output: "[bugfix/adit-core-bugs 7282e07] Improve comparison\n 2 files changed",
        commitMessage: "Improve comparison",
      }),
      expect.objectContaining({
        toolCallId: "call-commit",
        operation: "push",
        status: "success",
        cwd: "/repo",
      }),
    ]);
  });

  it("ignores ambiguous Codex desktop programs with multiple shell calls", () => {
    const path = transcript([
      { payload: { type: "message", role: "user", content: "inspect" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-many",
          name: "exec",
          input: 'const r = await Promise.all([tools.exec_command({cmd:"git status",workdir:"/repo"}),tools.exec_command({cmd:"git log -1",workdir:"/repo"})]);',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-many",
          output: [{ type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\nclean" }],
        },
      },
    ]);

    expect(extractGitOperations({
      platform: "codex",
      transcriptPath: path,
      defaultCwd: "/fallback",
    })).toEqual([]);
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
