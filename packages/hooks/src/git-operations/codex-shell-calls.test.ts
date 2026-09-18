import { describe, expect, it } from "vitest";
import { codexShellCalls } from "./codex-shell-calls.js";

const invocation = (id: string, command = "git commit -m fix") => ({ payload: {
  type: "function_call", call_id: id, name: "exec_command",
  arguments: JSON.stringify({ cmd: command, workdir: "/repo" }),
} });
const result = (id: string, code: number, output = "[main abc1234] fix") => ({ payload: {
  type: "function_call_output", call_id: id,
  output: "Chunk ID: chunk\nProcess exited with code " + code + "\nOutput:\n" + output,
} });

describe("codexShellCalls format compatibility", () => {
  it("pairs actual function calls with explicit success, cwd and output", () => {
    expect(codexShellCalls([invocation("commit-1"), result("commit-1", 0)], 0)).toEqual([{
      id: "commit-1", command: "git commit -m fix", cwd: "/repo", output: "[main abc1234] fix", success: true,
    }]);
  });

  it("does not mark failed, missing or unconfirmed results successful", () => {
    const calls = codexShellCalls([
      invocation("failed"), result("failed", 1, "nothing to commit"),
      invocation("missing"),
      invocation("unknown"), { payload: { type: "function_call_output", call_id: "unknown", output: "Output:\nProcess exited with code 0" } },
    ], 0);
    expect(calls).toEqual([expect.objectContaining({ id: "failed", success: false })]);
  });

  it("does not duplicate function calls also represented by a CommandExecution", () => {
    const calls = codexShellCalls([
      invocation("call-1"),
      { payload: { type: "item_completed", item: {
        type: "CommandExecution", id: "exec-1", command: ["pwsh", "-Command", "git commit -m fix"],
        cwd: "/repo", exit_code: 0, aggregated_output: "[main abc1234] fix",
      } } },
      result("call-1", 0),
      invocation("call-2"), result("call-2", 0),
    ], 0);
    expect(calls.map((call) => call.id)).toEqual(["exec-1", "call-2"]);
  });

  it("pairs old native begin/end records when only begin contains the command", () => {
    expect(codexShellCalls([
      { payload: { type: "exec_command_begin", call_id: "old", command: ["bash", "-lc", "git commit -m fix"], cwd: "/repo" } },
      { payload: { type: "exec_command_end", call_id: "old", exit_code: 0, stdout: "[main abc1234] fix" } },
    ], 0)).toEqual([expect.objectContaining({ id: "old", command: "git commit -m fix", cwd: "/repo", success: true })]);
  });

  it("waits for asynchronous completion and keeps earlier commit output", () => {
    const started = [
      invocation("start"),
      { payload: { type: "function_call_output", call_id: "start", output: "Process running with session ID 12\nOutput:\n[main abc1234] fix" } },
    ];
    expect(codexShellCalls(started, 0)).toEqual([]);
    expect(codexShellCalls([...started,
      { payload: { type: "function_call", call_id: "poll", name: "write_stdin", arguments: '{"session_id":12,"chars":""}' } },
      result("poll", 0, "done"),
    ], 0)).toEqual([expect.objectContaining({ id: "start", success: true, output: "[main abc1234] fix\ndone" })]);
  });

  it("accepts structured results and namespaced shell calls", () => {
    expect(codexShellCalls([
      { payload: { type: "function_call", call_id: "structured", name: "functions.shell_command", arguments: { command: "git commit -m fix", cwd: "/repo" } } },
      { payload: { type: "function_call_output", call_id: "structured", output: JSON.stringify({ exit_code: 0, stdout: "[main abc1234] fix" }) } },
    ], 0)).toEqual([expect.objectContaining({ id: "structured", success: true })]);
  });
});
