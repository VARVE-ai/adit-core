/**
 * Tests for Codex CLI adapter hook chaining (install/uninstall).
 *
 * Validates that installHooks() appends ADIT entries alongside
 * other tools' hooks instead of overwriting them, and that
 * uninstallHooks() removes only ADIT entries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { codexAdapter } from "./codex.js";
import { encodeProjectRoot } from "./command.js";
import { buildCodexHookStatesForEntries } from "./codex-trust.js";

/** Create a unique temp directory for each test */
function tempProjectRoot(): string {
  const dir = join(tmpdir(), `adit-hook-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readHooks(projectRoot: string): Record<string, unknown> {
  const hooksPath = join(projectRoot, ".codex", "hooks.json");
  return JSON.parse(readFileSync(hooksPath, "utf-8"));
}

function writeHooks(projectRoot: string, hooks: Record<string, unknown>): void {
  const codexDir = join(projectRoot, ".codex");
  if (!existsSync(codexDir)) {
    mkdirSync(codexDir, { recursive: true });
  }
  writeFileSync(join(codexDir, "hooks.json"), JSON.stringify(hooks, null, 2) + "\n");
}

describe("Codex CLI Hook Chaining", () => {
  let projectRoot: string;
  let codexHome: string;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    projectRoot = tempProjectRoot();
    codexHome = tempProjectRoot();
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    try {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("installs hooks into an empty project (no existing hooks)", async () => {
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    expect(hooks.Interrupt).toEqual([
      { hooks: [{ type: "command", command: expect.stringContaining(" stop"), timeout: 3 }] },
    ]);
    expect(hooks.SessionStart).toBeUndefined();
    // Shell snapshots: one Bash-matched entry before and after each command
    const preEntries = hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const postEntries = hooks.PostToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    expect(preEntries).toHaveLength(1);
    expect(preEntries[0].matcher).toBe("Bash");
    expect(preEntries[0].hooks[0].command).toContain("pre-tool-use");
    expect(postEntries).toHaveLength(1);
    expect(postEntries[0].matcher).toBe("Bash");
    expect(postEntries[0].hooks[0].command).toContain("post-tool-use");

    // Each event should have exactly one matcher group with one ADIT hook
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("adit-hook");

    // No project config.toml is written — the hooks feature is enabled by
    // default on Codex >= 0.124 (ADIT's baseline).
    expect(existsSync(join(projectRoot, ".codex", "config.toml"))).toBe(false);
    // The user-level Codex config is never written: approval happens in Codex.
    expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
  });

  it("removes ADIT hooks for every retired event on upgrade while preserving other tools", async () => {
    // Every event ADIT ever installed for this platform, as an old install
    // left it, plus another tool's hook under one of the retired events.
    const configPath = join(projectRoot, ".codex", "hooks.json");
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "startup|resume", hooks: [{ type: "command", command: "npx adit-hook --platform codex session-start", timeout: 30 }] }
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform codex prompt-submit", timeout: 30 }] }
        ],
        Stop: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform codex stop", timeout: 30 }] }
        ],
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "npx adit-hook --platform codex notification", timeout: 30 }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "other-tool after-bash", timeout: 30 }] }
        ],
      },
    }, null, 2) + "\n");

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = (JSON.parse(readFileSync(configPath, "utf-8")) as { hooks: Record<string, unknown[]> }).hooks;
    const eventsWithAdit = Object.keys(hooks)
      .filter((event) => JSON.stringify(hooks[event]).includes("adit-hook"))
      .sort();
    // Only this release's events carry ADIT entries — nothing retired lingers.
    expect(eventsWithAdit).toEqual(["Interrupt", "PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"]);
    for (const event of eventsWithAdit) {
      expect(hooks[event].filter((e) => JSON.stringify(e).includes("adit-hook"))).toHaveLength(1);
    }
    // The retired notification entry is gone; the other tool's hook under
    // PostToolUse is untouched and this release's snapshot entry sits beside it.
    expect(hooks.PostToolUse).toHaveLength(2);
    expect(JSON.stringify(hooks.PostToolUse)).toContain("other-tool after-bash");
    expect(JSON.stringify(hooks.PostToolUse)).toContain("post-tool-use");
    expect(JSON.stringify(hooks.PostToolUse)).not.toContain("notification");
  });

  it("preserves other tools' hooks when installing ADIT hooks", async () => {
    // Pre-install another tool's hooks
    const otherToolHook = {
      hooks: [
        { type: "command", command: "my-linter check", timeout: 10 },
      ],
    };
    writeHooks(projectRoot, {
      hooks: {
        SessionStart: [otherToolHook],
        Stop: [
          { hooks: [{ type: "command", command: "my-formatter run", timeout: 10 }] },
        ],
      },
    });

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    // ADIT no longer installs SessionStart; the other tool's hook is preserved.
    const sessionStartEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStartEntries).toHaveLength(1);
    expect(sessionStartEntries[0].hooks[0].command).toContain("my-linter");

    // Stop should also have both
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(2);
    expect(stopEntries[0].hooks[0].command).toContain("my-formatter");
    expect(stopEntries[1].hooks[0].command).toContain("adit-hook");
    expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
  });

  it("replaces stale ADIT hooks on reinstall (no duplicates)", async () => {
    // Simulate a previous ADIT install
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    // Reinstall with a different binary path (e.g., after update)
    await codexAdapter.installHooks(projectRoot, 'node "/new/path/hooks/dist/index.js"');

    const hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    // Should have exactly one entry per event, with the new path
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("/new/path/hooks/dist/index.js");
    expect(stopEntries[0].hooks[0].command).not.toContain("npx adit-hook");
  });

  it("preserves other tools' hooks on reinstall while replacing ADIT's", async () => {
    // Setup: another tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "my-linter check", timeout: 10 }],
    };
    writeHooks(projectRoot, {
      hooks: {
        UserPromptSubmit: [otherToolHook],
      },
    });

    // First ADIT install
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let hooksConfig = readHooks(projectRoot);
    let entries = (hooksConfig.hooks as Record<string, unknown[]>).UserPromptSubmit as unknown[];
    expect(entries).toHaveLength(2);

    // Reinstall ADIT (should replace old ADIT, keep linter)
    await codexAdapter.installHooks(projectRoot, 'node "/updated/hooks/dist/index.js"');

    hooksConfig = readHooks(projectRoot);
    entries = (hooksConfig.hooks as Record<string, unknown[]>).UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    expect(entries).toHaveLength(2);

    const commands = (entries as Array<{ hooks: Array<{ command: string }> }>).map(
      (e) => e.hooks[0].command,
    );
    expect(commands).toContain("my-linter check");
    expect(commands.some((c) => c.includes("/updated/hooks/dist/index.js"))).toBe(true);
    expect(commands.some((c) => c.includes("npx adit-hook"))).toBe(false);
  });

  it("preserves hook events that ADIT does not use", async () => {
    // Another tool registers a custom hook event ADIT doesn't know about
    writeHooks(projectRoot, {
      hooks: {
        CustomEvent: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "my-formatter run" }] },
        ],
      },
    });

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    // CustomEvent should be preserved exactly as-is
    const customEntries = hooks.CustomEvent as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0].matcher).toBe("Write|Edit");
    expect(customEntries[0].hooks[0].command).toBe("my-formatter run");

    // ADIT hooks should also be present
    expect(hooks.SessionStart).toBeUndefined();
    expect(hooks.Stop).toBeDefined();
  });

  it("preserves non-hook settings keys", async () => {
    writeHooks(projectRoot, {
      permissions: { allow: ["read", "write"] },
      model: "gpt-4",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "other-tool stop" }] }],
      },
    });

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    expect(hooksConfig.permissions).toEqual({ allow: ["read", "write"] });
    expect(hooksConfig.model).toBe("gpt-4");
  });

  it("refuses to overwrite a corrupted hooks file", async () => {
    const codexDir = join(projectRoot, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const hooksPath = join(codexDir, "hooks.json");
    writeFileSync(hooksPath, "{ invalid json }}}");

    // Must throw instead of silently rebuilding the file — the corrupt
    // file may hold other tools' hook config.
    await expect(
      codexAdapter.installHooks(projectRoot, "npx adit-hook"),
    ).rejects.toThrow("invalid JSON");

    // The corrupted file is left untouched for the user to fix.
    expect(readFileSync(hooksPath, "utf-8")).toBe("{ invalid json }}}");
  });

  it("uninstallHooks removes only ADIT entries, preserves others", async () => {
    // Setup: other tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "my-linter check", timeout: 10 }],
    };
    writeHooks(projectRoot, {
      hooks: {
        Stop: [otherToolHook],
        SessionStart: [
          { hooks: [{ type: "command", command: "my-formatter run", timeout: 10 }] },
        ],
      },
    });

    // Install ADIT alongside
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let hooksConfig = readHooks(projectRoot);
    expect((hooksConfig.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);

    // Uninstall ADIT
    await codexAdapter.uninstallHooks(projectRoot);

    hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    // Other tools' hooks should remain
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("my-linter");

    const sessionEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0].hooks[0].command).toContain("my-formatter");

    expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
  });

  it("leaves the user Codex config untouched during uninstall (legacy trust residue stays)", async () => {
    writeHooks(projectRoot, {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "other-tool stop", timeout: 10 }] },
          { hooks: [{ type: "command", command: "npx adit-hook --platform codex stop", timeout: 30 }] },
        ],
      },
    });
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    // A trust block written by an older ADIT version. Current versions never
    // edit this file, so the residue is left exactly as found.
    const originalUserConfig = [
      'model = "gpt-5.5"',
      "",
      "[features]",
      "hooks = true",
      "",
      '[hooks.state."/tmp/other/hooks.json:stop:0:0"]',
      "enabled = true",
      'trusted_hash = "sha256:user"',
      "",
      "# >>> adit-codex-hooks project=0123456789abcdef",
      `[hooks.state.${JSON.stringify(`${hooksPath}:stop:1:0`)}]`,
      "enabled = true",
      'trusted_hash = "sha256:adit"',
      "# <<< adit-codex-hooks project=0123456789abcdef",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), originalUserConfig);

    await codexAdapter.uninstallHooks(projectRoot);

    const hooksConfig = readHooks(projectRoot);
    const stopEntries = (hooksConfig.hooks as Record<string, unknown[]>).Stop as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toBe("other-tool stop");

    expect(readFileSync(join(codexHome, "config.toml"), "utf-8")).toBe(originalUserConfig);
  });

  it("uninstallHooks cleans up empty event arrays and hooks object", async () => {
    // Only ADIT hooks installed
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    await codexAdapter.uninstallHooks(projectRoot);

    const hooksConfig = readHooks(projectRoot);
    // hooks key should be deleted entirely when all events are empty
    expect(hooksConfig.hooks).toBeUndefined();
  });

  it("handles flat command entries from other tools", async () => {
    // Some tools may use flat command format instead of nested hooks array
    writeHooks(projectRoot, {
      hooks: {
        Stop: [
          { command: "my-tool stop", type: "command" },
        ],
      },
    });

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    const stopEntries = (hooksConfig.hooks as Record<string, unknown[]>).Stop;
    // Should preserve the flat entry + add ADIT's nested entry
    expect(stopEntries).toHaveLength(2);
  });

  it("install is idempotent — multiple installs with same path produce same result", async () => {
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");
    const first = readHooks(projectRoot);

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");
    const second = readHooks(projectRoot);

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");
    const third = readHooks(projectRoot);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("validateInstallation detects ADIT hooks in chained configuration", async () => {
    // Other tool installed first
    writeHooks(projectRoot, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "my-liner start", timeout: 30 }] },
        ],
      },
    });

    // Install ADIT alongside
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const result = await codexAdapter.validateInstallation(projectRoot);
    expect(result.valid).toBe(true);
    expect(result.checks.filter((c) => !c.advisory).every((c) => c.ok)).toBe(true);
  });

  describe("Hook mappings", () => {
    it("has exactly 5 hook mappings", () => {
      expect(codexAdapter.hookMappings).toHaveLength(5);
    });

    it("maps UserPromptSubmit to prompt-submit", () => {
      const mapping = codexAdapter.hookMappings.find(m => m.platformEvent === "UserPromptSubmit");
      expect(mapping).toEqual({
        platformEvent: "UserPromptSubmit",
        aditHandler: "prompt-submit"
      });
    });

    it("maps Stop to stop", () => {
      const mapping = codexAdapter.hookMappings.find(m => m.platformEvent === "Stop");
      expect(mapping).toEqual({
        platformEvent: "Stop",
        aditHandler: "stop"
      });
    });

    it("maps Interrupt to stop", () => {
      const mapping = codexAdapter.hookMappings.find(m => m.platformEvent === "Interrupt");
      expect(mapping).toEqual({
        platformEvent: "Interrupt",
        aditHandler: "stop"
      });
    });

    it("registers Bash-matched PreToolUse/PostToolUse for shell snapshots", () => {
      const toolMappings = codexAdapter.hookMappings.filter(
        (m) => m.platformEvent === "PreToolUse" || m.platformEvent === "PostToolUse",
      );
      expect(toolMappings).toEqual([
        { platformEvent: "PreToolUse", aditHandler: "pre-tool-use", matcher: "Bash" },
        { platformEvent: "PostToolUse", aditHandler: "post-tool-use", matcher: "Bash" },
      ]);
    });
  });

  describe("parseInput", () => {
    it("only reads schema fields — no thread_id/camelCase aliases", () => {
      const raw = {
        thread_id: "thread123",
        transcriptPath: "/path/to/transcript",
        cwd: "/project",
        hook_event_name: "SessionStart",
        model: "gpt-4"
      };

      const result = codexAdapter.parseInput(raw, "session-start");

      // Codex's hook schema sends session_id/transcript_path; aliases are
      // deliberately not honored.
      expect(result.platformSessionId).toBeUndefined();
      expect(result.transcriptPath).toBeUndefined();
    });

    it("parses UserPromptSubmit input correctly", () => {
      const raw = {
        session_id: "session123",
        prompt: "Hello, help me with my code",
        model: "gpt-4",
        cwd: "/project"
      };

      const result = codexAdapter.parseInput(raw, "prompt-submit");

      expect(result).toMatchObject({
        cwd: "/project",
        hookType: "prompt-submit",
        platformCli: "codex",
        platformSessionId: "session123",
        prompt: "Hello, help me with my code",
        rawPlatformData: raw
      });
    });

    it("parses Stop input correctly", () => {
      const raw = {
        session_id: "session123",
        stop_reason: "user_requested",
        last_assistant_message: "Done with task",
        model: "gpt-4",
        cwd: "/project"
      };

      const result = codexAdapter.parseInput(raw, "stop");

      expect(result).toMatchObject({
        cwd: "/project",
        hookType: "stop",
        platformCli: "codex",
        platformSessionId: "session123",
        stopReason: "user_requested",
        lastAssistantMessage: "Done with task",
        rawPlatformData: raw
      });
    });

    it("parses PostToolUse input correctly", () => {
      // Shape observed from Codex 0.154 for an exec_command call.
      const raw = {
        session_id: "session123",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "exec-0c80cc67-c3d9-4f02-97e3-d6f26204385d",
        turn_id: "01a0a33d-b246-7851-92e8-9b41781ac41f",
        tool_input: { command: "printf hello > probe/two.txt" },
        tool_response: "",
        transcript_path: "/home/u/.codex/sessions/2026/09/15/rollout.jsonl",
        model: "gpt-4",
        cwd: "/project"
      };

      const result = codexAdapter.parseInput(raw, "post-tool-use");

      expect(result).toMatchObject({
        cwd: "/project",
        hookType: "post-tool-use",
        platformCli: "codex",
        platformSessionId: "session123",
        transcriptPath: "/home/u/.codex/sessions/2026/09/15/rollout.jsonl",
        turnId: "01a0a33d-b246-7851-92e8-9b41781ac41f",
        toolName: "Bash",
        toolUseId: "exec-0c80cc67-c3d9-4f02-97e3-d6f26204385d",
        toolInput: { command: "printf hello > probe/two.txt" },
        rawPlatformData: raw
      });
    });
  });

  describe("generateHookConfig", () => {
    it("generates correct hook configuration", () => {
      const projectRoot = "/project with spaces";
      const fixedRootArg = `--project-root-b64 ${encodeProjectRoot(projectRoot)}`;
      const config = codexAdapter.generateHookConfig("npx adit-hook", projectRoot);

      expect(config).toEqual({
        configPath: ".codex/hooks.json",
        content: {
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: `npx adit-hook --platform codex ${fixedRootArg} prompt-submit`, timeout: 30 }] }
            ],
            Stop: [
              { hooks: [{ type: "command", command: `npx adit-hook --platform codex ${fixedRootArg} stop`, timeout: 30 }] }
            ],
            Interrupt: [
              { hooks: [{ type: "command", command: `npx adit-hook --platform codex ${fixedRootArg} stop`, timeout: 3 }] }
            ],
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: `npx adit-hook --platform codex ${fixedRootArg} pre-tool-use`, timeout: 30 }] }
            ],
            PostToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: `npx adit-hook --platform codex ${fixedRootArg} post-tool-use`, timeout: 30 }] }
            ]
          }
        }
      });
    });
  });

  describe("hasProjectHooks", () => {
    it("ignores legacy user-level trust residue after the project's .codex is deleted", async () => {
      // Older ADIT versions wrote a trust block into the user-level Codex
      // config; wiping the project directory leaves that residue behind. It
      // must not make the project look connected — by either predicate.
      await codexAdapter.installHooks(projectRoot, "npx adit-hook");
      const hooksPath = join(projectRoot, ".codex", "hooks.json");
      writeFileSync(join(codexHome, "config.toml"), [
        "# >>> adit-codex-hooks project=0123456789abcdef",
        `[hooks.state.${JSON.stringify(`${hooksPath}:stop:0:0`)}]`,
        "enabled = true",
        'trusted_hash = "sha256:adit"',
        "# <<< adit-codex-hooks project=0123456789abcdef",
        "",
      ].join("\n"));
      rmSync(join(projectRoot, ".codex"), { recursive: true, force: true });

      expect(await codexAdapter.hasHooks?.(projectRoot)).toBe(false);
      expect(await codexAdapter.hasProjectHooks?.(projectRoot)).toBe(false);
    });

    it("reports true when the project hooks file carries ADIT entries", async () => {
      await codexAdapter.installHooks(projectRoot, "npx adit-hook");
      expect(await codexAdapter.hasProjectHooks?.(projectRoot)).toBe(true);
    });
  });

  describe("validateInstallation", () => {
    it("detects valid installation with all hooks", async () => {
      // Install hooks
      await codexAdapter.installHooks(projectRoot, "npx adit-hook");

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(true);
      expect(result.checks.length).toBe(4);
      expect(result.checks[0].name).toBe(".codex directory");
      expect(result.checks[0].ok).toBe(true);
      expect(result.checks[1].name).toBe("Hook configuration");
      expect(result.checks[1].ok).toBe(true);
      // Advisory: nothing is approved in this fresh CODEX_HOME — ADIT never
      // writes it — but that must NOT fail validation (reinstall cannot fix
      // it and ensurePersistentCodexHooksInstalled would loop).
      expect(result.checks[2].name).toBe("Codex hook trust");
      expect(result.checks[2].ok).toBe(false);
      expect(result.checks[2].advisory).toBe(true);
      expect(result.checks[3].name).toBe("Codex workspace trust");
      expect(result.checks[3].ok).toBe(false);
      expect(result.checks[3].advisory).toBe(true);
    });

    it("reports workspace trust when the project is trusted in Codex", async () => {
      await codexAdapter.installHooks(projectRoot, "npx adit-hook");
      writeFileSync(
        join(codexHome, "config.toml"),
        `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n`,
      );

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(true);
      const trustCheck = result.checks.find((c) => c.name === "Codex workspace trust");
      expect(trustCheck?.ok).toBe(true);
    });

    it("reports ADIT hooks awaiting approval in Codex without failing validation", async () => {
      await codexAdapter.installHooks(projectRoot, "npx adit-hook");
      writeFileSync(join(codexHome, "config.toml"), "");

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(true);
      expect(result.checks[1].ok).toBe(true);
      expect(result.checks[2].name).toBe("Codex hook trust");
      expect(result.checks[2].ok).toBe(false);
      expect(result.checks[2].advisory).toBe(true);
      expect(result.checks[2].detail).toContain("5 hook(s) not yet approved");
      expect(result.checks[2].detail).toContain("/hooks");
    });

    it("reports hook trust once the user approved the hooks inside Codex", async () => {
      await codexAdapter.installHooks(projectRoot, "npx adit-hook");
      // Simulate the approval Codex records when the user accepts the hooks
      // via /hooks — the same key/hash scheme ADIT reads back.
      const hooksPath = join(projectRoot, ".codex", "hooks.json");
      const states = buildCodexHookStatesForEntries({
        hooksPath,
        hooks: readHooks(projectRoot).hooks as Record<string, unknown>,
        matchesEntry: () => true,
      });
      expect(states).toHaveLength(5);
      expect(states.map((state) => state.key.split(":").at(-3)).sort()).toEqual(
        ["interrupt", "post_tool_use", "pre_tool_use", "stop", "user_prompt_submit"],
      );
      writeFileSync(
        join(codexHome, "config.toml"),
        states.flatMap((state) => [
          `[hooks.state.${JSON.stringify(state.key)}]`,
          "enabled = true",
          `trusted_hash = ${JSON.stringify(state.trustedHash)}`,
          "",
        ]).join("\n"),
      );

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(true);
      const trustCheck = result.checks.find((c) => c.name === "Codex hook trust");
      expect(trustCheck?.ok).toBe(true);
    });

    it("detects old ADIT hook commands as needing upgrade", async () => {
      writeHooks(projectRoot, {
        hooks: {
          SessionStart: [
            { matcher: "startup|resume", hooks: [{ type: "command", command: "CODEX=1 npx adit-hook session-start", timeout: 30 }] },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "CODEX=1 npx adit-hook prompt-submit", timeout: 30 }] },
          ],
          Stop: [
            { hooks: [{ type: "command", command: "CODEX=1 npx adit-hook stop", timeout: 30 }] },
          ],
          PostToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "CODEX=1 npx adit-hook notification", timeout: 30 }] },
          ],
        },
      });

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(false);
      expect(result.checks[1].name).toBe("Hook configuration");
      expect(result.checks[1].ok).toBe(false);
    });

    it("detects missing .codex directory", async () => {
      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(false);
      expect(result.checks[0].name).toBe(".codex directory");
      expect(result.checks[0].ok).toBe(false);
    });

    it("detects missing hooks configuration", async () => {
      // Create .codex directory but no hooks.json
      const codexDir = join(projectRoot, ".codex");
      mkdirSync(codexDir, { recursive: true });

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(false);
      expect(result.checks[1].name).toBe("Hook configuration");
      expect(result.checks[1].ok).toBe(false);
      expect(result.checks[1].detail).toContain("No hook configuration found");
    });

    it("detects partial hooks configuration", async () => {
      // Install only some hooks manually
      writeHooks(projectRoot, {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "CODEX=1 npx adit-hook session-start", timeout: 10 }] }
          ]
          // Missing other hooks
        }
      });

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(false);
      expect(result.checks[1].name).toBe("Hook configuration");
      expect(result.checks[1].ok).toBe(false);
      expect(result.checks[1].detail).toContain("Missing hooks");
    });
  });

});
