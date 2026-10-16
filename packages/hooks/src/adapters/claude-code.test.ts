/**
 * Tests for Claude Code adapter hook chaining (install/uninstall).
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
import { claudeCodeAdapter } from "./claude-code.js";
import { encodeProjectRoot } from "./command.js";

/** Create a unique temp directory for each test */
function tempProjectRoot(): string {
  const dir = join(tmpdir(), `adit-hook-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readSettings(projectRoot: string): Record<string, unknown> {
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  return JSON.parse(readFileSync(settingsPath, "utf-8"));
}

function writeSettings(projectRoot: string, settings: Record<string, unknown>): void {
  const claudeDir = join(projectRoot, ".claude");
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
  writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify(settings, null, 2) + "\n");
}

describe("Claude Code Hook Chaining", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = tempProjectRoot();
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("installs hooks into an empty project (no existing settings)", async () => {
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    // StopFailure routes API-error turn ends through the stop handler
    expect(hooks.StopFailure).toBeDefined();
    expect(hooks.SessionStart).toBeUndefined();
    expect(hooks.SessionEnd).toBeUndefined();
    // notification / task-completed / subagent collection was retired
    expect(hooks.TaskCompleted).toBeUndefined();
    expect(hooks.Notification).toBeUndefined();
    expect(hooks.SubagentStart).toBeUndefined();
    expect(hooks.SubagentStop).toBeUndefined();

    // Each event should have exactly one matcher group with one ADIT hook
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("adit-hook");
    expect(stopEntries[0].hooks[0].command).toContain("--project-root-b64");
  });

  it("removes legacy ADIT SessionEnd hooks while preserving other tools", async () => {
    writeSettings(projectRoot, {
      hooks: {
        SessionEnd: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook session-end" }] },
          { hooks: [{ type: "command", command: "other-tool session-end" }] },
        ],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = readSettings(projectRoot).hooks as Record<string, unknown[]>;
    expect(JSON.stringify(hooks.SessionEnd)).not.toContain("adit-hook session-end");
    expect(JSON.stringify(hooks.SessionEnd)).toContain("other-tool session-end");
  });

  it("removes retired ADIT subagent hooks while preserving other tools", async () => {
    writeSettings(projectRoot, {
      hooks: {
        SubagentStart: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook subagent-start" }] },
        ],
        SubagentStop: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook subagent-stop" }] },
          { hooks: [{ type: "command", command: "other-tool subagent-stop" }] },
        ],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = readSettings(projectRoot).hooks as Record<string, unknown[]>;
    expect(hooks.SubagentStart).toBeUndefined();
    expect(JSON.stringify(hooks.SubagentStop)).not.toContain("adit-hook subagent-stop");
    expect(JSON.stringify(hooks.SubagentStop)).toContain("other-tool subagent-stop");
  });

  it("removes ADIT hooks for every retired event on upgrade while preserving other tools", async () => {
    // Every event ADIT ever installed for this platform, as an old install
    // left it, plus another tool's hook under one of the retired events.
    const configPath = join(projectRoot, ".claude", "settings.local.json");
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform claude prompt-submit", timeout: 30 }] }
        ],
        Stop: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform claude stop", timeout: 30 }] }
        ],
        SessionStart: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform claude session-start", timeout: 30 }] }
        ],
        SessionEnd: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform claude session-end", timeout: 30 }] }
        ],
        TaskCompleted: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform claude task-completed", timeout: 30 }] }
        ],
        Notification: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform claude notification", timeout: 30 }] },
          { hooks: [{ type: "command", command: "other-tool notify", timeout: 30 }] }
        ],
        SubagentStart: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform claude subagent-start", timeout: 30 }] }
        ],
        SubagentStop: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform claude subagent-stop", timeout: 30 }] }
        ],
      },
    }, null, 2) + "\n");

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = (JSON.parse(readFileSync(configPath, "utf-8")) as { hooks: Record<string, unknown[]> }).hooks;
    const eventsWithAdit = Object.keys(hooks)
      .filter((event) => JSON.stringify(hooks[event]).includes("adit-hook"))
      .sort();
    // Only this release's events carry ADIT entries — nothing retired lingers.
    expect(eventsWithAdit).toEqual(["PostToolUse", "PreToolUse", "Stop", "StopFailure", "UserPromptSubmit"]);
    for (const event of eventsWithAdit) {
      expect(hooks[event].filter((e) => JSON.stringify(e).includes("adit-hook"))).toHaveLength(1);
    }
    // The other tool's hook under a retired event is untouched.
    expect(hooks.Notification).toHaveLength(1);
    expect(JSON.stringify(hooks.Notification)).toContain("other-tool notify");
  });

  it("prunes retired ADIT events from the shared settings.json but keeps current ones", async () => {
    const claudeDir = join(projectRoot, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const sharedPath = join(claudeDir, "settings.json");
    writeFileSync(sharedPath, JSON.stringify({
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "npx adit-hook --platform claude stop" }] }],
        Notification: [
          { hooks: [{ type: "command", command: "npx adit-hook --platform claude notification" }] },
          { hooks: [{ type: "command", command: "other-tool notify" }] },
        ],
        SessionStart: [{ hooks: [{ type: "command", command: "npx adit-hook --platform claude session-start" }] }],
      },
    }, null, 2) + "\n");

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const shared = JSON.parse(readFileSync(sharedPath, "utf-8")) as {
      permissions?: unknown;
      hooks?: Record<string, unknown[]>;
    };
    expect(shared.permissions).toEqual({ allow: ["Bash(ls)"] });
    // A current-event ADIT entry in the shared file is the user's choice — kept.
    expect(JSON.stringify(shared.hooks?.Stop)).toContain("adit-hook");
    expect(shared.hooks?.SessionStart).toBeUndefined();
    expect(shared.hooks?.Notification).toHaveLength(1);
    expect(JSON.stringify(shared.hooks?.Notification)).toContain("other-tool notify");
  });

  it("preserves other tools' hooks when installing ADIT hooks", async () => {
    // Pre-install another tool's hooks (e.g., Entire CLI)
    const otherToolHook = {
      hooks: [
        { type: "command", command: "entire hook session-start", timeout: 5000 },
      ],
    };
    writeSettings(projectRoot, {
      hooks: {
        SessionStart: [otherToolHook],
        Stop: [
          { hooks: [{ type: "command", command: "entire hook stop", timeout: 5000 }] },
        ],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // ADIT no longer installs SessionStart; the other tool's hook is preserved.
    const sessionStartEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStartEntries).toHaveLength(1);
    expect(sessionStartEntries[0].hooks[0].command).toContain("entire");

    // Stop should also have both
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(2);
    expect(stopEntries[0].hooks[0].command).toContain("entire");
    expect(stopEntries[1].hooks[0].command).toContain("adit-hook");
  });

  it("replaces stale ADIT hooks on reinstall (no duplicates)", async () => {
    // Simulate a previous ADIT install
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    // Reinstall with a different binary path (e.g., after update)
    await claudeCodeAdapter.installHooks(projectRoot, 'node "/new/path/hooks/dist/index.js"');

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // Should have exactly one entry per event, with the new path
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("/new/path/hooks/dist/index.js");
    expect(stopEntries[0].hooks[0].command).not.toContain("npx adit-hook");
  });

  it("preserves other tools' hooks on reinstall while replacing ADIT's", async () => {
    // Setup: another tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "my-linter check", timeout: 3000 }],
    };
    writeSettings(projectRoot, {
      hooks: {
        UserPromptSubmit: [otherToolHook],
      },
    });

    // First ADIT install
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let settings = readSettings(projectRoot);
    let entries = (settings.hooks as Record<string, unknown[]>).UserPromptSubmit as unknown[];
    expect(entries).toHaveLength(2);

    // Reinstall ADIT (should replace old ADIT, keep linter)
    await claudeCodeAdapter.installHooks(projectRoot, 'node "/updated/hooks/dist/index.js"');

    settings = readSettings(projectRoot);
    entries = (settings.hooks as Record<string, unknown[]>).UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
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
    writeSettings(projectRoot, {
      hooks: {
        PostToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "my-formatter run" }] },
        ],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // The other tool's PostToolUse entry stays first and untouched; ADIT's
    // own Bash-matcher entry is appended after it.
    const postToolEntries = hooks.PostToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(postToolEntries).toHaveLength(2);
    expect(postToolEntries[0].matcher).toBe("Write|Edit");
    expect(postToolEntries[0].hooks[0].command).toBe("my-formatter run");
    expect(postToolEntries[1].matcher).toBe("Bash");
    expect(postToolEntries[1].hooks[0].command).toContain("adit-hook");

    // ADIT hooks should also be present
    expect(hooks.SessionStart).toBeUndefined();
    expect(hooks.Stop).toBeDefined();
  });

  it("preserves non-hook settings keys", async () => {
    writeSettings(projectRoot, {
      permissions: { allow: ["read", "write"] },
      model: "claude-sonnet-4-20250514",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "other-tool stop" }] }],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    expect(settings.permissions).toEqual({ allow: ["read", "write"] });
    expect(settings.model).toBe("claude-sonnet-4-20250514");
  });

  it("refuses to overwrite a corrupted settings file", async () => {
    const claudeDir = join(projectRoot, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.local.json");
    writeFileSync(settingsPath, "{ invalid json }}}");

    // Must throw instead of silently rebuilding the file — the corrupt
    // file may hold the user's own permissions/env config.
    await expect(
      claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook"),
    ).rejects.toThrow("invalid JSON");

    // The corrupted file is left untouched for the user to fix.
    expect(readFileSync(settingsPath, "utf-8")).toBe("{ invalid json }}}");
  });

  it("uninstallHooks removes only ADIT entries, preserves others", async () => {
    // Setup: other tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "entire hook stop", timeout: 5000 }],
    };
    writeSettings(projectRoot, {
      hooks: {
        Stop: [otherToolHook],
        SessionStart: [
          { hooks: [{ type: "command", command: "entire hook session-start" }] },
        ],
      },
    });

    // Install ADIT alongside
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let settings = readSettings(projectRoot);
    expect((settings.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);

    // Uninstall ADIT
    await claudeCodeAdapter.uninstallHooks(projectRoot);

    settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // Entire's hooks should remain
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("entire");

    const sessionEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0].hooks[0].command).toContain("entire");
  });

  it("uninstallHooks cleans up empty event arrays and hooks object", async () => {
    // Only ADIT hooks installed
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    await claudeCodeAdapter.uninstallHooks(projectRoot);

    const settings = readSettings(projectRoot);
    // hooks key should be deleted entirely when all events are empty
    expect(settings.hooks).toBeUndefined();
  });

  it("detects and removes partial Windows ADIT hooks from settings files", async () => {
    const claudeDir = join(projectRoot, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: 'node "C:\\Users\\me\\AppData\\Roaming\\npm\\ADIT-HOOK.CMD" --platform claude stop',
              },
            ],
          },
        ],
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "other-tool session-start",
              },
            ],
          },
        ],
      },
    }, null, 2) + "\n");

    await expect(claudeCodeAdapter.hasHooks?.(projectRoot)).resolves.toBe(true);

    await claudeCodeAdapter.uninstallHooks(projectRoot);

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks?.Stop).toBeUndefined();
    expect(settings.hooks?.SessionStart?.[0].hooks[0].command).toBe("other-tool session-start");
  });

  it("handles flat command entries from other tools", async () => {
    // Some tools may use flat command format instead of nested hooks array
    writeSettings(projectRoot, {
      hooks: {
        Stop: [
          { command: "my-tool stop", type: "command" },
        ],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const stopEntries = (settings.hooks as Record<string, unknown[]>).Stop;
    // Should preserve the flat entry + add ADIT's nested entry
    expect(stopEntries).toHaveLength(2);
  });

  it("install is idempotent — multiple installs with same path produce same result", async () => {
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");
    const first = readSettings(projectRoot);

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");
    const second = readSettings(projectRoot);

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");
    const third = readSettings(projectRoot);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("validateInstallation detects ADIT hooks in chained configuration", async () => {
    // Other tool installed first
    writeSettings(projectRoot, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "entire hook session-start" }] },
        ],
      },
    });

    // Install ADIT alongside
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const result = await claudeCodeAdapter.validateInstallation(projectRoot);
    expect(result.valid).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("validateInstallation marks old ADIT hook commands as needing upgrade", async () => {
    writeSettings(projectRoot, {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook prompt-submit" }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook stop" }] },
        ],
        StopFailure: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook stop" }] },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook pre-tool-use" }] },
        ],
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook post-tool-use" }] },
        ],
        SessionStart: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook session-start" }] },
        ],
        SessionEnd: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook session-end" }] },
        ],
        TaskCompleted: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook task-completed" }] },
        ],
        Notification: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook notification" }] },
        ],
        SubagentStart: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook subagent-start" }] },
        ],
        SubagentStop: [
          { hooks: [{ type: "command", command: "CLAUDE_CODE=1 npx adit-hook subagent-stop" }] },
        ],
      },
    });

    const result = await claudeCodeAdapter.validateInstallation(projectRoot);

    expect(result.valid).toBe(false);
    const hookCheck = result.checks.find((c) => c.name === "Hook configuration");
    expect(hookCheck?.ok).toBe(false);
    // Stale commands silently no-op at runtime — doctor must say how to fix,
    // not report them as missing.
    expect(hookCheck?.detail).toContain("Stale ADIT hooks");
    expect(hookCheck?.detail).toContain("re-run `adit init`");
    expect(hookCheck?.detail).not.toContain("Missing hooks");
  });

  it("validateInstallation reports an install that predates Bash snapshots as missing hooks", async () => {
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");
    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;
    delete hooks.PreToolUse;
    delete hooks.PostToolUse;
    writeSettings(projectRoot, settings);

    const result = await claudeCodeAdapter.validateInstallation(projectRoot);

    const hookCheck = result.checks.find((c) => c.name === "Hook configuration");
    expect(hookCheck?.ok).toBe(false);
    expect(hookCheck?.detail).toContain("Missing hooks: PreToolUse, PostToolUse");
  });

  it("validateInstallation hints at a moved project when the pinned root differs", async () => {
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");
    const settingsPath = join(projectRoot, ".claude", "settings.local.json");
    const movedRoot = "/somewhere/else";
    const rewritten = readFileSync(settingsPath, "utf-8").replaceAll(
      encodeProjectRoot(projectRoot),
      encodeProjectRoot(movedRoot),
    );
    writeFileSync(settingsPath, rewritten);

    const result = await claudeCodeAdapter.validateInstallation(projectRoot);

    expect(result.valid).toBe(false);
    const hookCheck = result.checks.find((c) => c.name === "Hook configuration");
    expect(hookCheck?.detail).toContain("project moved?");
    expect(hookCheck?.detail).toContain(movedRoot);
  });

  it("validateInstallation reports broken hooks when the script file is gone", async () => {
    // The exact uninstalled-global-CLI scenario: commands are pinned to this
    // project but reference a hook script that no longer exists on disk.
    await claudeCodeAdapter.installHooks(projectRoot, 'node "/gone/adit/hooks/dist/index.js"');

    const result = await claudeCodeAdapter.validateInstallation(projectRoot);

    expect(result.valid).toBe(false);
    const hookCheck = result.checks.find((c) => c.name === "Hook configuration");
    expect(hookCheck?.ok).toBe(false);
    expect(hookCheck?.detail).toContain("Broken ADIT hooks");
    expect(hookCheck?.detail).toContain("/gone/adit/hooks/dist/index.js");
    expect(hookCheck?.detail).toContain("re-run `adit init`");
    expect(hookCheck?.detail).not.toContain("Missing hooks");
  });
});
