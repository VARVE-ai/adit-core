/**
 * Tests for Cursor adapter.
 *
 * Validates shared hook generation and legacy Cursor migration,
 * install/uninstall chaining, and stdin field mapping.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { cursorAdapter, extractLastAssistantMessage } from "./cursor.js";
import { claudeCodeAdapter } from "./claude-code.js";

/** Create a unique temp directory for each test */
function tempProjectRoot(): string {
  const dir = join(tmpdir(), `adit-hook-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readSharedConfig(projectRoot: string): {
  hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  permissions?: { allow: string[] };
} {
  return JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
}

function writeHooks(projectRoot: string, hooks: Record<string, unknown>): void {
  const cursorDir = join(projectRoot, ".cursor");
  if (!existsSync(cursorDir)) {
    mkdirSync(cursorDir, { recursive: true });
  }
  writeFileSync(join(cursorDir, "hooks.json"), JSON.stringify(hooks, null, 2) + "\n");
}

describe("Cursor Adapter - Hook Generation", () => {
  it("uses the exact same configuration as Claude", () => {
    expect(cursorAdapter.generateHookConfig("npx adit-hook", "/project"))
      .toEqual(claudeCodeAdapter.generateHookConfig("npx adit-hook", "/project"));
    expect(cursorAdapter.hookMappings).toBe(claudeCodeAdapter.hookMappings);
    expect(cursorAdapter.generateHookConfig("npx adit-hook").configPath).toBe(".claude/settings.local.json");
  });
});

describe("Cursor Adapter - parseInput", () => {
  it("normalizes Windows workspace paths returned by Cursor URI objects", () => {
    expect(cursorAdapter.parseInput({ workspace_roots: ["/D:/workspace"] }, "prompt-submit").cwd).toBe("D:/workspace");
    expect(cursorAdapter.parseInput({ workspace_roots: ["/workspace"] }, "prompt-submit").cwd).toBe("/workspace");
  });

  it.each(["pre-tool-use", "post-tool-use"])("normalizes Cursor Shell data for %s snapshots", (hookType) => {
    const input = cursorAdapter.parseInput({
      conversation_id: "conversation", generation_id: "generation",
      tool_name: "Shell", tool_use_id: "call-1", tool_input: { command: "echo hi > file.md" },
      tool_output: { exit_code: 0 },
    }, hookType);
    expect(input).toMatchObject({
      platformCli: "cursor", platformSessionId: "conversation", turnId: "generation",
      toolName: "Bash", toolUseId: "call-1", toolInput: { command: "echo hi > file.md" },
      toolOutput: { exit_code: 0 },
    });
  });

  it("does not fabricate tool IDs from the generation ID", () => {
    const input = cursorAdapter.parseInput({ generation_id: "generation", tool_name: "Shell" }, "pre-tool-use");
    expect(input.toolUseId).toBeUndefined();
  });
  it("maps Cursor stdin fields to NormalizedHookInput", () => {
    const raw = {
      conversation_id: "conv-123",
      generation_id: "gen-456",
      model: "claude-sonnet-4-6",
      hook_event_name: "beforeSubmitPrompt",
      cursor_version: "1.7.2",
      workspace_roots: ["/path/to/project"],
      user_email: "user@example.com",
      transcript_path: "/path/to/transcript.jsonl",
    };

    const input = cursorAdapter.parseInput(raw, "prompt-submit");

    expect(input.cwd).toBe("/path/to/project");
    expect(input.platformSessionId).toBe("conv-123");
    expect(input.transcriptPath).toBe("/path/to/transcript.jsonl");
    expect(input.platformCli).toBe("cursor");
    expect(input.hookType).toBe("prompt-submit");
    expect(input.rawPlatformData).toBe(raw);
  });

  it("falls back to CURSOR_PROJECT_DIR env when workspace_roots is absent", () => {
    const original = process.env.CURSOR_PROJECT_DIR;
    process.env.CURSOR_PROJECT_DIR = "/env/project/dir";

    try {
      const raw = { conversation_id: "conv-1" };
      const input = cursorAdapter.parseInput(raw, "prompt-submit");
      expect(input.cwd).toBe("/env/project/dir");
    } finally {
      if (original !== undefined) {
        process.env.CURSOR_PROJECT_DIR = original;
      } else {
        delete process.env.CURSOR_PROJECT_DIR;
      }
    }
  });

  it("falls back to process.cwd() when neither workspace_roots nor CURSOR_PROJECT_DIR is set", () => {
    const original = process.env.CURSOR_PROJECT_DIR;
    delete process.env.CURSOR_PROJECT_DIR;

    try {
      const raw = { conversation_id: "conv-1" };
      const input = cursorAdapter.parseInput(raw, "prompt-submit");
      expect(input.cwd).toBe(process.cwd());
    } finally {
      if (original !== undefined) {
        process.env.CURSOR_PROJECT_DIR = original;
      }
    }
  });
});

describe("Cursor shared hooks and legacy migration", () => {
  let projectRoot: string;

  beforeEach(() => { projectRoot = tempProjectRoot(); });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it("installs the shared hooks without creating a Cursor hooks file", async () => {
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");
    expect(existsSync(join(projectRoot, ".cursor", "hooks.json"))).toBe(false);
    const hooks = readSharedConfig(projectRoot).hooks;
    expect(Object.keys(hooks)).toEqual(["UserPromptSubmit", "Stop", "StopFailure", "PreToolUse", "PostToolUse"]);
    expect(hooks.Stop[0].hooks[0].command).toContain("--platform claude");
    expect((await cursorAdapter.validateInstallation(projectRoot)).valid).toBe(true);
  });

  it.each(["cursor", "claude"])("migrates native hooks through the %s installer and preserves other tools", async (platform) => {
    const other = { command: "other-tool before", timeout: 5 };
    const nested = { type: "command", command: "other-tool stop" };
    writeHooks(projectRoot, {
      version: 1, custom: { enabled: true },
      hooks: {
        beforeSubmitPrompt: [{ command: "npx adit-hook --platform cursor prompt-submit" }, other],
        stop: [{ matcher: "*", hooks: [{ command: "adit-hook stop" }, nested] }],
        sessionEnd: [{ command: "adit-hook session-end" }],
        afterFileEdit: [{ command: "other-tool edited" }],
      },
    });
    const adapter = platform === "cursor" ? cursorAdapter : claudeCodeAdapter;
    await adapter.installHooks(projectRoot, "npx adit-hook");
    const native = JSON.parse(readFileSync(join(projectRoot, ".cursor", "hooks.json"), "utf8"));
    expect(native).toEqual({
      version: 1, custom: { enabled: true },
      hooks: {
        beforeSubmitPrompt: [other], stop: [{ matcher: "*", hooks: [nested] }],
        afterFileEdit: [{ command: "other-tool edited" }],
      },
    });
    expect((await cursorAdapter.validateInstallation(projectRoot)).valid).toBe(true);
  });

  it("preserves unrelated native configuration byte-for-byte", async () => {
    writeHooks(projectRoot, { version: 1, hooks: { stop: [{ command: "other-tool stop" }] } });
    const path = join(projectRoot, ".cursor", "hooks.json");
    const before = readFileSync(path, "utf8");
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("preserves shared permissions and non-ADIT hooks", async () => {
    mkdirSync(join(projectRoot, ".claude"));
    const other = { hooks: [{ command: "other-tool stop" }] };
    writeFileSync(join(projectRoot, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Bash(git status)"] }, hooks: { Stop: [other] },
    }));
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");
    const config = readSharedConfig(projectRoot);
    expect(config.permissions).toEqual({ allow: ["Bash(git status)"] });
    expect(config.hooks.Stop).toHaveLength(2);
    expect(config.hooks.Stop[0]).toEqual(other);
  });

  it("refuses migration of corrupted native settings without modifying either config", async () => {
    mkdirSync(join(projectRoot, ".cursor"));
    const path = join(projectRoot, ".cursor", "hooks.json");
    writeFileSync(path, "{broken");
    await expect(cursorAdapter.installHooks(projectRoot, "npx adit-hook")).rejects.toThrow("invalid hook configuration");
    expect(readFileSync(path, "utf8")).toBe("{broken");
    expect(existsSync(join(projectRoot, ".claude", "settings.local.json"))).toBe(false);
  });

  it("keeps native recording intact if shared configuration cannot be installed", async () => {
    writeHooks(projectRoot, { version: 1, hooks: { stop: [{ command: "adit-hook --platform cursor stop" }] } });
    mkdirSync(join(projectRoot, ".claude"));
    writeFileSync(join(projectRoot, ".claude", "settings.local.json"), "{broken");
    const path = join(projectRoot, ".cursor", "hooks.json");
    const before = readFileSync(path, "utf8");
    await expect(cursorAdapter.installHooks(projectRoot, "npx adit-hook")).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("detects native-only installations so init can migrate them", async () => {
    writeHooks(projectRoot, { version: 1, hooks: { stop: [{ command: "adit-hook --platform cursor stop" }] } });
    expect(await cursorAdapter.hasHooks!(projectRoot)).toBe(true);
    expect((await cursorAdapter.validateInstallation(projectRoot)).valid).toBe(false);
  });

  it("is idempotent across both installers", async () => {
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");
    const before = readSharedConfig(projectRoot);
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");
    expect(readSharedConfig(projectRoot)).toEqual(before);
  });

  it("uninstalls both shared and legacy ADIT entries without removing other hooks", async () => {
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");
    writeHooks(projectRoot, { version: 1, hooks: { stop: [{ command: "adit-hook stop" }, { command: "other stop" }] } });
    await cursorAdapter.uninstallHooks(projectRoot);
    expect(readSharedConfig(projectRoot).hooks).toBeUndefined();
    expect(JSON.parse(readFileSync(join(projectRoot, ".cursor", "hooks.json"), "utf8")))
      .toEqual({ version: 1, hooks: { stop: [{ command: "other stop" }] } });
    expect(await cursorAdapter.hasHooks!(projectRoot)).toBe(false);
  });

  it("preserves a pinned parent root in shared commands", async () => {
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook", { hookProjectRoot: "/parent" });
    expect(readSharedConfig(projectRoot).hooks.Stop[0].hooks[0].command)
      .toContain(Buffer.from("/parent").toString("base64url"));
  });
});

describe("Cursor Adapter - extractLastAssistantMessage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `adit-transcript-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("extracts last assistant text from JSONL transcript", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Hi there!" }] } }),
    ].join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("Hi there!");
  });

  it("extracts assistant text from the type-shaped format (Cursor CLI stream-json)", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Typed shape reply" }] } }),
    ].join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("Typed shape reply");
  });

  it("extracts multi-block assistant message", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "explain" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [
        { type: "text", text: "Part one." },
        { type: "tool_use", name: "ReadFile", input: {} },
        { type: "text", text: "Part two." },
      ] } }),
    ].join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("Part one.\nPart two.");
  });

  it("returns last assistant message when multiple exist", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "q1" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "a1" }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "q2" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "a2" }] } }),
    ].join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("a2");
  });

  it("returns undefined for file with no assistant messages", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } }),
    ].join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBeUndefined();
  });

  it("returns undefined for nonexistent file", () => {
    const result = extractLastAssistantMessage(join(tempDir, "nope.jsonl"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty file", () => {
    const transcriptPath = join(tempDir, "empty.jsonl");
    writeFileSync(transcriptPath, "");
    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBeUndefined();
  });

  it("skips assistant entries with only tool_use (no text)", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: {} }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Done!" }] } }),
    ].join("\n") + "\n");

    // Scans backwards — finds "Done!" first
    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("Done!");
  });

  it("handles large files by reading only the tail", () => {
    const transcriptPath = join(tempDir, "large.jsonl");
    // Write 200 lines to ensure tail-only reading
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `filler ${i}` }] } }));
    }
    // The important line is at the very end
    lines.push(JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Final answer" }] } }));
    writeFileSync(transcriptPath, lines.join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("Final answer");
  });
});

describe("Cursor Adapter - parseInput stop fields", () => {
  it("maps raw.status to stopReason for stop events", () => {
    const raw = {
      conversation_id: "conv-123",
      workspace_roots: ["/path/to/project"],
      status: "completed",
    };

    const input = cursorAdapter.parseInput(raw, "stop");

    expect(input.hookType).toBe("stop");
    expect(input.stopReason).toBe("completed");
  });

  it("extracts lastAssistantMessage from transcript when available", () => {
    const tempDir = join(tmpdir(), `adit-stop-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const transcriptPath = join(tempDir, "transcript.jsonl");
      writeFileSync(transcriptPath, [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "10+3=?" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "10 + 3 = 13" }] } }),
      ].join("\n") + "\n");

      const raw = {
        conversation_id: "conv-123",
        workspace_roots: ["/path/to/project"],
        status: "completed",
        transcript_path: transcriptPath,
      };

      const input = cursorAdapter.parseInput(raw, "stop");

      expect(input.stopReason).toBe("completed");
      expect(input.lastAssistantMessage).toBe("10 + 3 = 13");
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

});
