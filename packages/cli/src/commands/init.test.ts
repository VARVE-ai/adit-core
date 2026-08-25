import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeRepoProjectId, readProjectManifest } from "@varveai/adit-core";

const mocks = vi.hoisted(() => ({
  getHeadSha: vi.fn(async () => null as string | null),
  getRemoteUrl: vi.fn(async () => null as string | null),
  detectPlatforms: vi.fn(() => []),
  listAdapters: vi.fn(() => []),
  resolveAditHookBinary: vi.fn(() => "adit-hook"),
  getAdapter: vi.fn(),
}));

vi.mock("@varveai/adit-engine", () => ({
  getHeadSha: mocks.getHeadSha,
  getRemoteUrl: mocks.getRemoteUrl,
}));

vi.mock("@varveai/adit-hooks/adapters", () => ({
  detectPlatforms: mocks.detectPlatforms,
  listAdapters: mocks.listAdapters,
  resolveAditHookBinary: mocks.resolveAditHookBinary,
  getAdapter: mocks.getAdapter,
}));

import { initCommand } from "./init.js";

describe("initCommand", () => {
  let root: string;
  let originalExit: typeof process.exit;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adit-init-"));
    vi.clearAllMocks();
    mocks.getHeadSha.mockResolvedValue(null);
    mocks.getRemoteUrl.mockResolvedValue(null);
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

  it("initializes an empty-git container as a multi-repo project with --multi-repo", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });

    await initCommand({ cwd: root, multiRepo: true });

    const manifest = readProjectManifest(root);
    expect(manifest?.projectType).toBe("workspace");
    expect(manifest?.repositories.map((repo) => repo.relativePath)).toEqual(["api", "web"]);
    expect(existsSync(join(root, ".adit", "adit.sqlite"))).toBe(true);
    expect(existsSync(join(root, ".adit", "workspace.json"))).toBe(false);
    expect(existsSync(join(root, "api", ".adit"))).toBe(false);
  });

  it("fails non-interactively when the layout is ambiguous and no mode flag is given", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });

    await expect(initCommand({ cwd: root })).rejects.toThrow("process.exit:1");

    expect(readProjectManifest(root)).toBeNull();
    expect(existsSync(join(root, ".adit", "adit.sqlite"))).toBe(false);
  });

  it("initializes a normal repository with a remote without asking", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");

    await initCommand({ cwd: root });

    const manifest = readProjectManifest(root);
    expect(manifest?.projectType).toBe("repo");
    expect(manifest?.repositories).toEqual([{ relativePath: "." }]);
    expect(manifest?.projectId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("fails without writing anything when nothing is initializable", async () => {
    await expect(initCommand({ cwd: root })).rejects.toThrow("process.exit:1");
    expect(existsSync(join(root, ".adit"))).toBe(false);
  });

  it("initializes a member repository independently without touching the parent manifest", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });
    const parentBefore = readFileSync(join(root, ".adit", "project.json"), "utf-8");

    await initCommand({ cwd: join(root, "api"), singleRepo: true });

    const child = readProjectManifest(join(root, "api"));
    expect(child?.projectType).toBe("repo");
    expect(child?.projectId).not.toBe(JSON.parse(parentBefore).projectId);
    expect(readFileSync(join(root, ".adit", "project.json"), "utf-8")).toBe(parentBefore);
  });

  it("migrates a legacy workspace project keeping its identity", async () => {
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(
      join(root, ".adit", "workspace.json"),
      JSON.stringify({ workspaceId: "legacy-workspace-1", createdAt: new Date().toISOString() }),
      "utf-8",
    );
    mkdirSync(join(root, "api", ".git"), { recursive: true });

    await initCommand({ cwd: root, multiRepo: true });

    const manifest = readProjectManifest(root);
    expect(manifest?.projectId).toBe("legacy-workspace-1");
    expect(manifest?.projectType).toBe("workspace");
    expect(existsSync(join(root, ".adit", "workspace.json"))).toBe(false);
  });

  it("migrates a legacy single-repo project via the path-derivation fallback", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(join(root, ".adit", "adit.sqlite"), "", "utf-8");
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");

    await initCommand({ cwd: root });

    const manifest = readProjectManifest(root);
    expect(manifest?.projectId).toBe(computeRepoProjectId(root));
  });

  it("keeps identity and repository list on an unchanged re-init", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });
    const before = readProjectManifest(root)!;

    await initCommand({ cwd: root });

    const after = readProjectManifest(root)!;
    expect(after.projectId).toBe(before.projectId);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.repositories).toEqual(before.repositories);
  });

  it("updates the repository list on re-init with --multi-repo after a new repo appears", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });
    const before = readProjectManifest(root)!;

    mkdirSync(join(root, "new-service", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });

    const after = readProjectManifest(root)!;
    expect(after.projectId).toBe(before.projectId);
    expect(after.repositories.map((repo) => repo.relativePath)).toEqual(["api", "new-service"]);
  });

  it("keeps the repository list on non-interactive re-init without flags", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });
    mkdirSync(join(root, "new-service", ".git"), { recursive: true });

    await initCommand({ cwd: root });

    const manifest = readProjectManifest(root)!;
    expect(manifest.repositories.map((repo) => repo.relativePath)).toEqual(["api"]);
  });

  it("writes the generate-docs prompt and refreshes it on re-init", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");

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
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");
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
