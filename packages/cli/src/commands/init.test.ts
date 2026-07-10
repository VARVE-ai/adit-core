import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isGitRepo: vi.fn(),
  detectPlatforms: vi.fn(() => []),
  listAdapters: vi.fn(() => []),
  resolveAditHookBinary: vi.fn(() => "adit-hook"),
  getAdapter: vi.fn(),
}));

vi.mock("@varveai/adit-engine", () => ({
  isGitRepo: mocks.isGitRepo,
}));

vi.mock("@varveai/adit-hooks/adapters", () => ({
  detectPlatforms: mocks.detectPlatforms,
  listAdapters: mocks.listAdapters,
  resolveAditHookBinary: mocks.resolveAditHookBinary,
  getAdapter: mocks.getAdapter,
}));

import { initCommand } from "./init.js";

describe("initCommand workspace mode", () => {
  let root: string;
  let originalExit: typeof process.exit;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adit-init-workspace-"));
    vi.clearAllMocks();
    process.exitCode = undefined;
    originalExit = process.exit;
    originalLog = console.log;
    originalError = console.error;
    process.exit = vi.fn((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never;
    console.log = vi.fn() as never;
    console.error = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  });

  it("initializes a workspace root with --workspace when child repos exist", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mocks.isGitRepo.mockResolvedValue(false);

    await initCommand({ cwd: root, workspace: true });

    expect(existsSync(join(root, ".adit", "workspace.json"))).toBe(true);
    expect(existsSync(join(root, ".adit", "adit.sqlite"))).toBe(true);
    expect(existsSync(join(root, "api", ".adit"))).toBe(false);
  });

  it("refuses non-interactive workspace init without --workspace", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mocks.isGitRepo.mockResolvedValue(false);

    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

    try {
      await expect(initCommand({ cwd: root })).rejects.toThrow("process.exit:1");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinTty });
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutTty });
    }

    expect(existsSync(join(root, ".adit", "workspace.json"))).toBe(false);
  });

  it("keeps normal Git repo init behavior", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mocks.isGitRepo.mockResolvedValue(true);

    await initCommand({ cwd: root });

    expect(existsSync(join(root, ".adit", "adit.sqlite"))).toBe(true);
    expect(existsSync(join(root, ".adit", "workspace.json"))).toBe(false);
  });

  it("initializes a child Git repo independently when parent workspace exists", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mocks.isGitRepo.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await initCommand({ cwd: root, workspace: true });
    const manifestPath = join(root, ".adit", "workspace.json");
    const manifestBefore = readFileSync(manifestPath, "utf-8");

    await initCommand({ cwd: join(root, "api") });

    expect(existsSync(join(root, ".adit", "adit.sqlite"))).toBe(true);
    expect(existsSync(join(root, "api", ".adit", "adit.sqlite"))).toBe(true);
    expect(existsSync(join(root, "api", ".adit", "workspace.json"))).toBe(false);
    expect(readFileSync(manifestPath, "utf-8")).toBe(manifestBefore);
  });

  it("writes the generate-docs prompt and refreshes it on re-init", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mocks.isGitRepo.mockResolvedValue(true);

    await initCommand({ cwd: root });

    const promptPath = join(root, ".adit", "prompts", "generate-docs.md");
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, "utf-8")).toContain("adit docs validate");

    // adit owns this copy — re-init overwrites in-place edits
    writeFileSync(promptPath, "user edits");
    await initCommand({ cwd: root });
    expect(readFileSync(promptPath, "utf-8")).not.toBe("user edits");
  });

  it("preserves legacy per-platform generate-docs files", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mocks.isGitRepo.mockResolvedValue(true);
    const legacyFiles = [
      join(root, ".claude", "skills", "generate-docs.md"),
      join(root, ".opencode", "commands", "generate-docs.md"),
      join(root, ".cursor", "rules", "generate-docs.mdc"),
    ];
    for (const file of legacyFiles) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "old skill");
    }

    await initCommand({ cwd: root });

    for (const file of legacyFiles) {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf-8")).toBe("old skill");
    }
  });
});
