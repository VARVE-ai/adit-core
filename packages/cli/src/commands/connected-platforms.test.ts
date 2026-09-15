import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "@varveai/adit-hooks/adapters";
import {
  addConnectedPlatforms,
  connectedPlatformsPath,
  ensureConnectedPlatformsRecorded,
  readConnectedPlatforms,
  removeConnectedPlatform,
  writeConnectedPlatforms,
} from "./connected-platforms.js";

describe("connected platforms record", () => {
  let root: string;
  let codexHome: string;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adit-platforms-"));
    codexHome = mkdtempSync(join(tmpdir(), "adit-codex-home-"));
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    mkdirSync(join(root, ".adit"), { recursive: true });
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  it("returns null when no record exists", () => {
    expect(readConnectedPlatforms(root)).toBeNull();
  });

  it("round-trips, dedupes and sorts the platform list", () => {
    writeConnectedPlatforms(root, ["codex", "claude-code", "codex"]);
    expect(readConnectedPlatforms(root)).toEqual(["claude-code", "codex"]);
  });

  it("treats a corrupt record as absent", () => {
    writeFileSync(connectedPlatformsPath(root), "{nope");
    expect(readConnectedPlatforms(root)).toBeNull();
  });

  it("drops unknown platform names on read", () => {
    writeFileSync(
      connectedPlatformsPath(root),
      JSON.stringify({ schemaVersion: 1, connected: ["claude-code", "made-up-tool"] }),
    );
    expect(readConnectedPlatforms(root)).toEqual(["claude-code"]);
  });

  it("backfills a legacy project from existing hook configuration", async () => {
    // A pre-record project with ADIT hooks already installed for Claude.
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "npx adit-hook --platform claude stop" }] }],
        },
      }),
    );

    const connected = await ensureConnectedPlatformsRecorded(root);

    expect(connected).toContain("claude-code");
    expect(connected).not.toContain("codex");
    // The backfill persists, so the next read needs no derivation.
    expect(readConnectedPlatforms(root)).toContain("claude-code");
  });

  it("backfills an empty list when nothing is installed", async () => {
    expect(await ensureConnectedPlatformsRecorded(root)).toEqual([]);
    expect(readConnectedPlatforms(root)).toEqual([]);
  });

  it("backfill ignores user-level codex trust residue on a fresh project", async () => {
    // Reproduces the real pollution: codex hooks were once installed (which
    // also wrote a user-level trust block), the project's adit traces were
    // wiped for a fresh start, but the user-level residue survived. The
    // fresh project must backfill empty, not "codex connected".
    const codexAdapter = getAdapter("codex");
    await codexAdapter.installHooks(root, "npx adit-hook");
    rmSync(join(root, ".codex"), { recursive: true, force: true });
    rmSync(connectedPlatformsPath(root), { force: true });

    const connected = await ensureConnectedPlatformsRecorded(root);

    expect(connected).toEqual([]);
  });

  it("add merges with the existing record", async () => {
    writeConnectedPlatforms(root, ["claude-code"]);
    const merged = await addConnectedPlatforms(root, ["codex"]);
    expect(merged.sort()).toEqual(["claude-code", "codex"]);
    expect(readConnectedPlatforms(root)).toEqual(["claude-code", "codex"]);
  });

  it("add on a legacy project keeps derived platforms", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "npx adit-hook --platform claude stop" }] }],
        },
      }),
    );

    await addConnectedPlatforms(root, ["cursor"]);

    const record = readConnectedPlatforms(root);
    expect(record).toContain("claude-code");
    expect(record).toContain("cursor");
  });

  it("remove deletes only the given platform", async () => {
    writeConnectedPlatforms(root, ["claude-code", "codex"]);
    await removeConnectedPlatform(root, "codex");
    expect(readConnectedPlatforms(root)).toEqual(["claude-code"]);
  });

  it("writes a versioned record file", () => {
    writeConnectedPlatforms(root, ["codex"]);
    const raw = JSON.parse(readFileSync(connectedPlatformsPath(root), "utf-8"));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.connected).toEqual(["codex"]);
    expect(typeof raw.updatedAt).toBe("string");
  });

  it.each(["claude-code", "claude-vscode", "cursor"] as const)("records all shared platforms when connecting %s", async (platform) => {
    await addConnectedPlatforms(root, [platform]);
    expect(readConnectedPlatforms(root)).toEqual(["claude-code", "claude-vscode", "cursor"]);
  });

  it.each(["claude-code", "claude-vscode", "cursor"] as const)("removes all shared platforms when disconnecting %s", async (platform) => {
    writeConnectedPlatforms(root, ["claude-code", "claude-vscode", "cursor", "codex"]);
    await removeConnectedPlatform(root, platform);
    expect(readConnectedPlatforms(root)).toEqual(["codex"]);
  });
});
