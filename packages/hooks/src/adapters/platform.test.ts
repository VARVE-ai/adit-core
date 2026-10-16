import { describe, expect, it } from "vitest";
import { resolveHookPlatform } from "./platform.js";
import { getAdapter } from "./registry.js";

describe("shared hook platform resolution", () => {
  it.each(["claude", "claude-code", "claude-vscode"] as const)("routes Cursor payloads from %s hooks to Cursor", (platform) => {
    expect(resolveHookPlatform(platform, { cursor_version: "3.19.19" }, {})).toBe("cursor");
  });

  it("prioritizes the payload over inherited extension environment variables", () => {
    expect(resolveHookPlatform("claude", { cursor_version: "3.19.19" }, {
      ELECTRON_RUN_AS_NODE: "1", VSCODE_IPC_HOOK: "pipe",
    })).toBe("cursor");
  });

  it("does not mistake Claude in a Cursor terminal for Cursor", () => {
    expect(resolveHookPlatform("claude", { model: "claude-sonnet" }, {
      CURSOR_PROJECT_DIR: "/project", TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "trace",
    })).toBe("claude-code");
  });

  it("keeps Claude VS Code detection when the payload is not from Cursor", () => {
    expect(resolveHookPlatform("claude", {}, {
      ELECTRON_RUN_AS_NODE: "1", VSCODE_IPC_HOOK: "pipe",
    })).toBe("claude-vscode");
  });

  it.each([null, "", "  ", 3])("ignores invalid Cursor version %s", (version) => {
    expect(resolveHookPlatform("claude", { cursor_version: version }, {})).toBe("claude-code");
  });

  it.each(["codex", "gemini", "opencode", "cursor"] as const)("preserves explicit %s routing", (platform) => {
    expect(resolveHookPlatform(platform, { cursor_version: "3.19.19" }, {})).toBe(platform);
  });

  it("requires an explicit platform", () => {
    expect(resolveHookPlatform(null, { cursor_version: "3.19.19" }, {})).toBeNull();
  });

  it("parses a Cursor compatibility payload using the Cursor adapter", () => {
    const raw = {
      cursor_version: "3.19.19", conversation_id: "cursor-conversation", session_id: "cursor-conversation",
      generation_id: "generation", workspace_roots: ["/D:/workspace/project"],
      model: "claude-sonnet", prompt: "hello", hook_event_name: "beforeSubmitPrompt",
    };
    const platform = resolveHookPlatform("claude", raw, {});
    expect(platform).toBe("cursor");
    const input = getAdapter(platform!).parseInput(raw, "prompt-submit");
    expect(input).toMatchObject({
      platformCli: "cursor", platformSessionId: "cursor-conversation", turnId: "generation",
      cwd: "D:/workspace/project", prompt: "hello",
    });
  });
});
