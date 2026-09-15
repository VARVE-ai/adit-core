import { describe, expect, it } from "vitest";
import {
  buildPlatformChoices,
  diffSelection,
  keepDisconnectedSelection,
  parseSelectionAnswer,
  selectablePlatforms,
} from "./init-platform-select.js";
import type { Platform } from "@varveai/adit-core";

describe("selectablePlatforms", () => {
  it("lists implemented platforms, hides bundled companions, cursor last", () => {
    const platforms = selectablePlatforms();
    expect(platforms).toEqual(["claude-code", "codex", "gemini", "opencode"]);
    expect(platforms).not.toContain("claude-vscode");
  });
});

describe("buildPlatformChoices", () => {
  it("pre-checks by detection on a first run without a record", () => {
    const choices = buildPlatformChoices({
      connected: [],
      detected: ["claude-code", "codex"],
      hasRecord: false,
    });
    const byPlatform = Object.fromEntries(choices.map((c) => [c.platform, c]));
    expect(byPlatform["claude-code"].preChecked).toBe(true);
    expect(byPlatform["codex"].preChecked).toBe(true);
    expect(byPlatform["gemini"].preChecked).toBe(false);
    expect(byPlatform["cursor"]).toBeUndefined();
    expect(byPlatform["claude-code"].displayName).toBe("Claude Code / Cursor");
  });

  it("pre-checks by record on a re-run; detection is annotation only", () => {
    const choices = buildPlatformChoices({
      connected: ["codex"],
      detected: ["claude-code", "codex", "gemini"],
      hasRecord: true,
    });
    const byPlatform = Object.fromEntries(choices.map((c) => [c.platform, c]));
    // claude is installed on the machine but the user never connected it
    expect(byPlatform["claude-code"].preChecked).toBe(false);
    expect(byPlatform["claude-code"].detected).toBe(true);
    expect(byPlatform["codex"].preChecked).toBe(true);
  });

  it("keeps a connected platform pre-checked even when its CLI left PATH", () => {
    // The dangerous case: a temporarily missing CLI must not lead to a
    // silent disconnect on plain Enter.
    const choices = buildPlatformChoices({
      connected: ["claude-code"],
      detected: [],
      hasRecord: true,
    });
    const claude = choices.find((c) => c.platform === "claude-code");
    expect(claude?.preChecked).toBe(true);
    expect(claude?.detected).toBe(false);
  });

  it("treats a record holding only the bundled companion as connected", () => {
    const choices = buildPlatformChoices({
      connected: ["claude-vscode"],
      detected: [],
      hasRecord: true,
    });
    expect(choices.find((c) => c.platform === "claude-code")?.connected).toBe(true);
  });

  it("pre-checks shared Claude hooks for a legacy Cursor-only record", () => {
    const choices = buildPlatformChoices({
      connected: ["cursor"],
      detected: [],
      hasRecord: true,
    });
    expect(choices.find((c) => c.platform === "claude-code")?.preChecked).toBe(true);
  });
});

describe("diffSelection", () => {
  const choices = buildPlatformChoices({
    connected: ["claude-code", "codex"],
    detected: ["claude-code", "codex", "gemini"],
    hasRecord: true,
  });

  it("computes connect, disconnect and refresh sets with bundles expanded", () => {
    // add gemini, drop codex, keep claude
    const plan = diffSelection(choices, new Set<Platform>(["claude-code", "gemini"]));
    expect(plan.toConnect).toEqual(["gemini"]);
    expect(plan.toDisconnect).toEqual(["codex"]);
    expect(plan.toRefresh).toEqual(["claude-code", "claude-vscode", "cursor"]);
    expect(plan.finalRecord.sort()).toEqual(["claude-code", "claude-vscode", "cursor", "gemini"]);
  });

  it("disconnecting claude also disconnects the bundled vscode companion", () => {
    const plan = diffSelection(choices, new Set<Platform>(["codex"]));
    expect(plan.toDisconnect).toEqual(["claude-code", "claude-vscode", "cursor"]);
  });

  it("plain keep-as-shown produces refresh only", () => {
    const plan = diffSelection(choices, new Set<Platform>(["claude-code", "codex"]));
    expect(plan.toConnect).toEqual([]);
    expect(plan.toDisconnect).toEqual([]);
    expect(plan.toRefresh.sort()).toEqual(["claude-code", "claude-vscode", "codex", "cursor"]);
  });
});

describe("keepDisconnectedSelection", () => {
  it("re-adds connected platforms after a declined disconnect", () => {
    const choices = buildPlatformChoices({
      connected: ["claude-code"],
      detected: [],
      hasRecord: true,
    });
    const kept = keepDisconnectedSelection(choices, new Set<Platform>(["gemini"]));
    expect(kept.has("claude-code")).toBe(true);
    expect(kept.has("gemini")).toBe(true);
  });
});

describe("parseSelectionAnswer", () => {
  const choices = buildPlatformChoices({
    connected: ["claude-code"],
    detected: ["claude-code", "codex"],
    hasRecord: true,
  });
  // list order: claude-code(1, checked), codex(2), gemini(3), opencode(4)

  it("Enter keeps the pre-checked state", () => {
    expect(parseSelectionAnswer("", choices)).toEqual(new Set(["claude-code"]));
  });

  it("numbers toggle against the pre-checked state", () => {
    expect(parseSelectionAnswer("1,2", choices)).toEqual(new Set(["codex"]));
  });

  it("a selects everything, n selects nothing", () => {
    expect(parseSelectionAnswer("a", choices)?.size).toBe(choices.length);
    expect(parseSelectionAnswer("n", choices)).toEqual(new Set());
  });

  it("repeated numbers toggle once", () => {
    expect(parseSelectionAnswer("2 2", choices)).toEqual(new Set(["claude-code", "codex"]));
  });

  it("rejects out-of-range or non-numeric answers", () => {
    expect(parseSelectionAnswer("9", choices)).toBeNull();
    expect(parseSelectionAnswer("yes please", choices)).toBeNull();
  });
});
