/**
 * Tests for portable hook command construction and parsing.
 */

import { describe, expect, it } from "vitest";
import {
  buildAditHookCommand,
  classifyAditHookEntries,
  describeHookValidation,
  encodeProjectRoot,
  extractHookScriptPath,
  extractPinnedProjectRoot,
  isAditHookCommand,
  isFixedProjectRootHookCommand,
  parseHookArgs,
} from "./command.js";

describe("Hook Command Helpers", () => {
  it("builds commands with explicit platform arguments", () => {
    const command = buildAditHookCommand("npx adit-hook", "codex", "stop");

    expect(command).toBe("npx adit-hook --platform codex stop");
  });

  it("builds commands with a fixed project root argument", () => {
    const projectRoot = "/Users/me/Project With Spaces";
    const command = buildAditHookCommand("npx adit-hook", "codex", "stop", projectRoot);

    expect(command).toBe(
      `npx adit-hook --platform codex --project-root-b64 ${encodeProjectRoot(projectRoot)} stop`,
    );
    expect(isFixedProjectRootHookCommand(command, projectRoot)).toBe(true);
  });

  it("round-trips Windows project roots without shell-sensitive quoting", () => {
    const projectRoot = "C:\\Users\\Me\\Adit Projects\\workspace";
    const command = buildAditHookCommand("adit-hook.cmd", "cursor", "session-start", projectRoot);
    const args = command.split(" ").slice(1);

    expect(parseHookArgs(args)).toEqual({
      platform: "cursor",
      hookType: "session-start",
      projectRoot,
    });
  });

  it("parses platform flag before hook type", () => {
    expect(parseHookArgs(["--platform", "cursor", "prompt-submit"])).toEqual({
      platform: "cursor",
      hookType: "prompt-submit",
      projectRoot: null,
    });
  });

  it("parses platform flag after hook type", () => {
    expect(parseHookArgs(["stop", "--platform=gemini"])).toEqual({
      platform: "gemini",
      hookType: "stop",
      projectRoot: null,
    });
  });

  it("keeps old positional hook commands working", () => {
    expect(parseHookArgs(["session-start"])).toEqual({
      platform: null,
      hookType: "session-start",
      projectRoot: null,
    });
  });

  it("parses project root in equals form", () => {
    const projectRoot = "/repo";

    expect(parseHookArgs(["stop", `--project-root-b64=${encodeProjectRoot(projectRoot)}`])).toEqual({
      platform: null,
      hookType: "stop",
      projectRoot,
    });
  });

  it("identifies ADIT hook commands with Windows paths", () => {
    expect(isAditHookCommand('node "C:\\tools\\hooks\\dist\\index.js" stop')).toBe(true);
  });

  it("identifies ADIT hook commands with mixed-case Windows paths", () => {
    expect(isAditHookCommand('node "C:\\Users\\me\\AppData\\Roaming\\npm\\ADIT-HOOK.CMD" stop')).toBe(true);
    expect(isAditHookCommand('node "C:\\tools\\Hooks\\Dist\\Index.js" stop')).toBe(true);
  });

  it("extracts the pinned project root from a command", () => {
    const command = buildAditHookCommand("/tmp/adit-hook", "claude", "stop", "/repo");
    expect(extractPinnedProjectRoot(command)).toBe("/repo");
    expect(extractPinnedProjectRoot("/tmp/adit-hook --platform claude stop")).toBeNull();
  });

  it("extracts the script path from node-form commands", () => {
    expect(extractHookScriptPath('node "/opt/adit/hooks/dist/index.js" --platform claude stop'))
      .toBe("/opt/adit/hooks/dist/index.js");
    expect(extractHookScriptPath("node '/opt/adit hooks/dist/index.js' stop"))
      .toBe("/opt/adit hooks/dist/index.js");
    expect(extractHookScriptPath("node /opt/adit/hooks/dist/index.js stop"))
      .toBe("/opt/adit/hooks/dist/index.js");
    expect(extractHookScriptPath('node "C:\\tools\\hooks\\dist\\index.js" stop'))
      .toBe("C:\\tools\\hooks\\dist\\index.js");
  });

  it("returns no script path for PATH-based commands", () => {
    expect(extractHookScriptPath("adit-hook --platform claude stop")).toBeNull();
    expect(extractHookScriptPath("npx adit-hook --platform claude stop")).toBeNull();
    expect(extractHookScriptPath("/tmp/adit-hook --platform claude stop")).toBeNull();
  });
});

describe("classifyAditHookEntries", () => {
  const root = "/repo";
  const pinned = buildAditHookCommand("/tmp/adit-hook", "claude", "stop", root);
  const unpinned = "/tmp/adit-hook --platform claude stop";
  const otherRoot = buildAditHookCommand("/tmp/adit-hook", "claude", "stop", "/moved/repo");

  it("returns ok when any entry is pinned to the expected root", () => {
    const result = classifyAditHookEntries(
      [{ command: unpinned }, { hooks: [{ command: pinned }] }],
      root,
    );
    expect(result.status).toBe("ok");
  });

  it("returns stale for legacy commands without a pinned root", () => {
    const result = classifyAditHookEntries([{ hooks: [{ command: unpinned }] }], root);
    expect(result.status).toBe("stale");
    expect(result.stalePinnedRoots).toEqual([""]);
  });

  it("returns stale with the foreign root when the project moved", () => {
    const result = classifyAditHookEntries([{ command: otherRoot }], root);
    expect(result.status).toBe("stale");
    expect(result.stalePinnedRoots).toEqual(["/moved/repo"]);
  });

  it("returns absent when no ADIT commands exist", () => {
    const result = classifyAditHookEntries(
      [{ command: "eslint --fix" }, { hooks: [{ command: "prettier -w ." }] }],
      root,
    );
    expect(result.status).toBe("absent");
  });

  const deadScript = "/gone/adit/hooks/dist/index.js";
  const liveScript = "/opt/adit/hooks/dist/index.js";
  const pinnedDead = buildAditHookCommand(`node "${deadScript}"`, "claude", "stop", root);
  const pinnedLive = buildAditHookCommand(`node "${liveScript}"`, "claude", "stop", root);
  const scriptExists = (scriptPath: string) => scriptPath === liveScript;

  it("returns broken when the pinned command's script no longer exists", () => {
    const result = classifyAditHookEntries(
      [{ hooks: [{ command: pinnedDead }] }],
      root,
      { scriptExists },
    );
    expect(result.status).toBe("broken");
    expect(result.brokenScriptPaths).toEqual([deadScript]);
  });

  it("returns ok when the pinned command's script exists", () => {
    const result = classifyAditHookEntries(
      [{ hooks: [{ command: pinnedLive }] }],
      root,
      { scriptExists },
    );
    expect(result.status).toBe("ok");
    expect(result.brokenScriptPaths).toEqual([]);
  });

  it("prefers a healthy entry over a broken one", () => {
    const result = classifyAditHookEntries(
      [{ hooks: [{ command: pinnedDead }] }, { hooks: [{ command: pinnedLive }] }],
      root,
      { scriptExists },
    );
    expect(result.status).toBe("ok");
  });

  it("reports broken over stale when both are present", () => {
    const result = classifyAditHookEntries(
      [{ command: otherRoot }, { hooks: [{ command: pinnedDead }] }],
      root,
      { scriptExists },
    );
    expect(result.status).toBe("broken");
    expect(result.brokenScriptPaths).toEqual([deadScript]);
  });

  it("leaves PATH-based commands unchecked", () => {
    const result = classifyAditHookEntries(
      [{ hooks: [{ command: pinned }] }],
      root,
      { scriptExists: () => false },
    );
    expect(result.status).toBe("ok");
  });
});

describe("describeHookValidation", () => {
  const base = {
    configPath: "/repo/.claude/settings.local.json",
    projectRoot: "/repo",
  };

  it("reports ok when nothing is missing or stale", () => {
    const result = describeHookValidation({
      ...base,
      missingHooks: [],
      staleHooks: [],
      stalePinnedRoots: [],
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("All hooks registered");
  });

  it("tells users to re-run init for legacy commands", () => {
    const result = describeHookValidation({
      ...base,
      missingHooks: [],
      staleHooks: ["Stop", "UserPromptSubmit"],
      stalePinnedRoots: [""],
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("re-run `adit init`");
    expect(result.detail).toContain("no pinned project root");
  });

  it("hints at a moved project when pinned roots differ", () => {
    const result = describeHookValidation({
      ...base,
      missingHooks: ["SessionStart"],
      staleHooks: ["Stop"],
      stalePinnedRoots: ["/old/location"],
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("project moved?");
    expect(result.detail).toContain("/old/location");
    expect(result.detail).toContain("Missing hooks: SessionStart");
  });

  it("points at the missing script for broken hooks", () => {
    const result = describeHookValidation({
      ...base,
      missingHooks: [],
      staleHooks: [],
      stalePinnedRoots: [],
      brokenHooks: ["Stop", "UserPromptSubmit"],
      brokenScriptPaths: ["/gone/adit/hooks/dist/index.js"],
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Broken ADIT hooks: Stop, UserPromptSubmit");
    expect(result.detail).toContain("/gone/adit/hooks/dist/index.js");
    expect(result.detail).toContain("re-run `adit init`");
  });
});
