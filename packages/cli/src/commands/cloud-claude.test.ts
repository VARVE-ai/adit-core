import { describe, expect, it } from "vitest";
import { isLocalIdleHook, isTerminalClaudeErrorEvent } from "./cloud-claude.js";

describe("isLocalIdleHook", () => {
  it("treats Claude completion hooks as local idle", () => {
    expect(isLocalIdleHook("Stop", {})).toBe(true);
    expect(isLocalIdleHook("StopFailure", {})).toBe(true);
    expect(isLocalIdleHook("SessionEnd", {})).toBe(true);
  });

  it("does not treat SubagentStop as idle — subagents finish mid-turn", () => {
    expect(isLocalIdleHook("SubagentStop", {})).toBe(false);
  });

  it("treats only error-like Claude notifications as local idle", () => {
    expect(isLocalIdleHook("Notification", {
      message: "API Error: safety policy rejected the request",
    })).toBe(true);
    expect(isLocalIdleHook("Notification", {
      message: "Claude is waiting for your input",
    })).toBe(false);
  });
});

describe("isTerminalClaudeErrorEvent", () => {
  it("treats Claude API safety failures as terminal local errors", () => {
    expect(isTerminalClaudeErrorEvent({
      type: "tool",
      payload: {
        status: "error",
        error: "Claude Code returned an error result: API Error: [1301][系统检测到输入或生成内容可能包含不安全或敏感内容]",
      },
    })).toBe(true);
  });

  it("treats synthetic Claude API safety messages as terminal local errors", () => {
    expect(isTerminalClaudeErrorEvent({
      type: "message",
      payload: {
        role: "assistant",
        modelId: "<synthetic>",
        text: "API Error: [1301][系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语]",
      },
    })).toBe(true);
  });

  it("treats synthetic Claude API overload messages as terminal local errors", () => {
    expect(isTerminalClaudeErrorEvent({
      type: "message",
      payload: {
        role: "assistant",
        modelId: "<synthetic>",
        text: "API Error: 529 [1305][该模型当前访问量过大，请您稍后再试]. This is a server-side issue, usually temporary.",
      },
    })).toBe(true);
  });

  it("treats Claude API overload error results as terminal local errors", () => {
    expect(isTerminalClaudeErrorEvent({
      type: "tool",
      payload: {
        status: "error",
        error: "Claude Code returned an error result: API Error: 529 [1305][该模型当前访问量过大，请您稍后再试]",
      },
    })).toBe(true);
  });

  it("does not treat ordinary tool errors as terminal Claude errors", () => {
    expect(isTerminalClaudeErrorEvent({
      type: "tool",
      payload: {
        status: "error",
        error: "Bash command failed with exit code 1",
      },
    })).toBe(false);
  });
});
