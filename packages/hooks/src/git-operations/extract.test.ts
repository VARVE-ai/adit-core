import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractGitOperations } from "./extract.js";
import { codexShellCalls } from "./codex-shell-calls.js";

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


/** The `item_completed` record Codex writes for every shell command it ran. */
function commandExecution(item: Record<string, unknown>) {
  return { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", ...item } } };
}

describe("extractGitOperations", () => {
  it("does not mistake a completed Codex item for a successful command", () => {
    const calls = codexShellCalls([
      commandExecution({ id: "exec-fail", command: "git commit -m fix", status: "completed", exit_code: 1, aggregated_output: "nothing to commit" }),
      commandExecution({ id: "exec-string-code", command: "git commit -m fix", status: "completed", exit_code: "1" }),
      commandExecution({ id: "exec-no-code", command: "git status", status: "failed" }),
    ], 0);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => !call.success)).toBe(true);
  });

  it("extracts only Codex Git commands from the latest turn", () => {
    const path = transcript([
      { payload: { type: "message", role: "user", content: "old" } },
      commandExecution({ id: "exec-old", command: ["/bin/zsh", "-lc", "git status"], cwd: "file:///repo", status: "completed", exit_code: 0 }),
      { payload: { type: "message", role: "user", content: "new" } },
      commandExecution({
        id: "exec-new",
        command: ["/bin/zsh", "-lc", "git add a.ts && git commit -m fix"],
        cwd: "file:///repo",
        status: "completed",
        exit_code: 0,
        aggregated_output: "[main abc1234] fix",
      }),
    ]);

    expect(extractGitOperations({
      platform: "codex",
      transcriptPath: path,
      defaultCwd: "/fallback",
    })).toEqual([
      expect.objectContaining({ toolCallId: "exec-new", operationIndex: 0, operation: "add", cwd: "/repo" }),
      expect.objectContaining({ toolCallId: "exec-new", operationIndex: 1, operation: "commit", cwd: "/repo", output: "[main abc1234] fix", commitMessage: "fix" }),
    ]);
  });

  it("reads each Codex command execution with its own directory and output", () => {
    // One exec script that commits in two repositories produces two
    // CommandExecution records; the script text itself is never inspected.
    const path = transcript([
      { type: "session_meta", payload: { session_id: "codex-desktop-1" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "commit both" }] } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-batch",
          name: "exec",
          input: 'for (const repo of ["cloud", "core"]) text(await tools.shell({ command: "git commit -m fix", cwd: repo }));',
        },
      },
      commandExecution({
        id: "exec-cloud",
        command: ["/bin/zsh", "-lc", "git commit -m \"fix: cloud\""],
        cwd: "file:///work/cloud",
        status: "completed",
        exit_code: 0,
        aggregated_output: "[main 1111111] fix: cloud\n 1 file changed\n",
      }),
      commandExecution({
        id: "exec-core",
        command: ["/bin/zsh", "-lc", "git commit -m \"fix: core\""],
        cwd: "file:///work/core",
        status: "completed",
        exit_code: 0,
        stdout: "[main 2222222] fix: core\n",
        stderr: "",
      }),
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-batch", output: [{ type: "input_text", text: "Script completed\nOutput:\n" }] } },
    ]);

    expect(extractGitOperations({
      platform: "codex",
      transcriptPath: path,
      expectedSessionId: "codex-desktop-1",
      defaultCwd: "/fallback",
    })).toEqual([
      expect.objectContaining({
        toolCallId: "exec-cloud",
        operation: "commit",
        status: "success",
        cwd: "/work/cloud",
        output: "[main 1111111] fix: cloud\n 1 file changed\n",
        commitMessage: "fix: cloud",
      }),
      expect.objectContaining({
        toolCallId: "exec-core",
        operation: "commit",
        status: "success",
        cwd: "/work/core",
        output: "[main 2222222] fix: core\n",
        commitMessage: "fix: core",
      }),
    ]);
  });

  it("ignores Codex items that are not command executions and retired native records", () => {
    const path = transcript([
      { payload: { type: "message", role: "user", content: "inspect" } },
      { payload: { type: "exec_command_end", call_id: "legacy", command: "git commit -m legacy", status: "completed", exit_code: 0 } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id: "patch-1", status: "completed", changes: {} } } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "Reasoning", id: "reasoning-1" } } },
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
