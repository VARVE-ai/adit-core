/**
 * Tests for portable hook command construction and parsing.
 */

import { describe, expect, it } from "vitest";
import {
  buildAditHookCommand,
  encodeProjectRoot,
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
});
