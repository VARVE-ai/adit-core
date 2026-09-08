import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeRepoProjectId,
  deriveProjectType,
  readProjectManifest,
  writeProjectManifest,
} from "@varveai/adit-core";

const mocks = vi.hoisted(() => ({
  getHeadSha: vi.fn(async () => null as string | null),
  getRemoteUrl: vi.fn(async () => null as string | null),
  detectPlatforms: vi.fn(() => []),
  detectInstalledPlatforms: vi.fn(() => []),
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
  detectInstalledPlatforms: mocks.detectInstalledPlatforms,
  listAdapters: mocks.listAdapters,
  resolveAditHookBinary: mocks.resolveAditHookBinary,
  getAdapter: mocks.getAdapter,
}));

vi.mock("./init-cloud-setup.js", () => ({
  runCloudSetupSection: vi.fn(async () => ({ linked: false })),
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

    const manifest = readProjectManifest(root)!;
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.projectType).toBeUndefined();
    expect(deriveProjectType(manifest)).toBe("workspace");
    // The empty root repository is registered but not synced; --multi-repo syncs the children.
    expect(manifest.repositories.map((repo) => [repo.relativePath, repo.syncEnabled !== false])).toEqual([
      [".", false],
      ["api", true],
      ["web", true],
    ]);
    expect(existsSync(join(root, ".adit", "adit.sqlite"))).toBe(true);
    expect(existsSync(join(root, ".adit", "workspace.json"))).toBe(false);
    expect(existsSync(join(root, "api", ".adit"))).toBe(false);
  });

  it("uses a singular repository label for a one-member Workspace", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });

    await initCommand({ cwd: root, multiRepo: true });

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("work across the repository is recorded");
    expect(output).not.toContain("all 1 repositories");
  });

  it("registers an empty root repository and its children non-interactively, syncing only the children", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });

    await initCommand({ cwd: root });

    const manifest = readProjectManifest(root)!;
    expect(manifest.repositories.map((repo) => [repo.relativePath, repo.syncEnabled !== false])).toEqual([
      [".", false],
      ["api", true],
      ["web", true],
    ]);
  });

  it("keeps a root repository with a remote as the synced project and offers children unsynced", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockImplementation(async (path: string) =>
      path === root ? "https://example.com/root.git" : "https://example.com/api.git",
    );

    await initCommand({ cwd: root });

    const manifest = readProjectManifest(root)!;
    expect(manifest.repositories).toEqual([
      { relativePath: "." },
      expect.objectContaining({ relativePath: "api", syncEnabled: false, repositoryUrl: "https://example.com/api.git" }),
    ]);
    expect(deriveProjectType(manifest)).toBe("workspace");
  });

  it("syncs an explicit --repos selection including the root", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");

    await initCommand({ cwd: root, repos: ["./", "api"] });

    const manifest = readProjectManifest(root)!;
    expect(manifest.repositories.map((repo) => [repo.relativePath, repo.syncEnabled !== false])).toEqual([
      [".", true],
      ["api", true],
      ["web", false],
    ]);
  });

  it("rejects --repos paths that are not repositories here", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });

    await expect(initCommand({ cwd: root, repos: ["missing"] })).rejects.toThrow("process.exit:1");
    expect(readProjectManifest(root)).toBeNull();
  });

  it("initializes a normal repository with a remote without asking", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");

    await initCommand({ cwd: root });

    const manifest = readProjectManifest(root)!;
    expect(manifest.schemaVersion).toBe(2);
    expect(deriveProjectType(manifest)).toBe("repo");
    expect(manifest.repositories).toEqual([{ relativePath: "." }]);
    expect(manifest.projectId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("fails without writing anything when nothing is initializable", async () => {
    await expect(initCommand({ cwd: root })).rejects.toThrow("process.exit:1");
    expect(existsSync(join(root, ".adit"))).toBe(false);
  });

  it("does not initialize a repository that a parent project already registers", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });
    const parentBefore = readFileSync(join(root, ".adit", "project.json"), "utf-8");
    vi.mocked(console.log).mockClear();

    await initCommand({ cwd: join(root, "api"), singleRepo: true });

    expect(readProjectManifest(join(root, "api"))).toBeNull();
    expect(existsSync(join(root, "api", ".adit"))).toBe(false);
    expect(readFileSync(join(root, ".adit", "project.json"), "utf-8")).toBe(parentBefore);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("already belongs to the project at");
    expect(output).toContain("--detach");
  });

  it("--detach splits a registered member repository into its own project", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });
    const parentBefore = readProjectManifest(root)!;

    await initCommand({ cwd: join(root, "api"), singleRepo: true, detach: true });

    const child = readProjectManifest(join(root, "api"))!;
    expect(deriveProjectType(child)).toBe("repo");
    expect(child.projectId).not.toBe(parentBefore.projectId);
    const parentAfter = readProjectManifest(root)!;
    expect(parentAfter.projectId).toBe(parentBefore.projectId);
    expect(parentAfter.repositories.map((repo) => repo.relativePath)).toEqual(["web"]);
  });

  it("moves an already initialized child project up with --absorb, keeping its identity", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockImplementation(async (path: string) =>
      path === join(root, "api") ? "https://example.com/api.git" : null,
    );
    await initCommand({ cwd: join(root, "api") });
    const child = readProjectManifest(join(root, "api"))!;
    expect(existsSync(join(root, "api", ".adit", "adit.sqlite"))).toBe(true);

    await initCommand({ cwd: root, absorb: true });

    const parent = readProjectManifest(root)!;
    expect(parent.projectId).toBe(child.projectId);
    expect(parent.createdAt).toBe(child.createdAt);
    expect(parent.repositories).toEqual([
      { relativePath: "api", repositoryId: child.projectId, repositoryUrl: "https://example.com/api.git" },
      expect.objectContaining({ relativePath: "web" }),
    ]);
    // The data directory moved up; the child no longer carries a manifest.
    expect(existsSync(join(root, ".adit", "adit.sqlite"))).toBe(true);
    expect(existsSync(join(root, "api", ".adit"))).toBe(false);
    expect(readProjectManifest(join(root, "api"))).toBeNull();
  });

  it("keeps a child project independent and unsynced when not absorbed non-interactively", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockImplementation(async (path: string) =>
      path === join(root, "api") ? "https://example.com/api.git" : null,
    );
    await initCommand({ cwd: join(root, "api") });
    const child = readProjectManifest(join(root, "api"))!;
    const childBefore = readFileSync(join(root, "api", ".adit", "project.json"), "utf-8");

    await initCommand({ cwd: root });

    const parent = readProjectManifest(root)!;
    expect(parent.projectId).not.toBe(child.projectId);
    expect(parent.repositories).toEqual([
      expect.objectContaining({ relativePath: "api", repositoryId: child.projectId, syncEnabled: false }),
      expect.objectContaining({ relativePath: "web" }),
    ]);
    expect(readFileSync(join(root, "api", ".adit", "project.json"), "utf-8")).toBe(childBefore);
  });

  it("marks further child projects as merged when one of them moves up", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");
    await initCommand({ cwd: join(root, "api") });
    await initCommand({ cwd: join(root, "web") });
    const api = readProjectManifest(join(root, "api"))!;
    const web = readProjectManifest(join(root, "web"))!;

    await initCommand({ cwd: root, absorb: true });

    const parent = readProjectManifest(root)!;
    // Equal session counts: the earlier created project (api) wins.
    expect(parent.projectId).toBe(api.projectId);
    expect(parent.repositories).toEqual([
      expect.objectContaining({ relativePath: "api", repositoryId: api.projectId }),
      expect.objectContaining({ relativePath: "web", repositoryId: web.projectId }),
    ]);
    // A merged member follows the normal selection, so it syncs by default.
    expect(parent.repositories.find((repo) => repo.relativePath === "web")?.syncEnabled).not.toBe(false);
    expect(readProjectManifest(join(root, "web"))!.mergedIntoProjectId).toBe(api.projectId);
    // A merged member routes to the parent project.
    const { loadConfig } = await import("@varveai/adit-core");
    expect(loadConfig(join(root, "web")).projectId).toBe(api.projectId);
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

    const manifest = readProjectManifest(root)!;
    expect(manifest.projectId).toBe("legacy-workspace-1");
    expect(deriveProjectType(manifest)).toBe("workspace");
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

  it("preserves init selection and Cloud deletion tombstones on non-interactive re-init", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });
    const before = readProjectManifest(root)!;
    writeProjectManifest(root, {
      ...before,
      repositories: before.repositories.map((repository) =>
        repository.relativePath === "api"
          ? { ...repository, syncEnabled: false }
          : {
              ...repository,
              cloudDeletedAt: "2026-09-01T00:00:00.000Z",
              cloudDeletionOperationId: "operation-web",
            },
      ),
    });

    await initCommand({ cwd: root, multiRepo: true });

    expect(readProjectManifest(root)!.repositories).toEqual([
      expect.objectContaining({ relativePath: "api", syncEnabled: false }),
      expect.objectContaining({
        relativePath: "web",
        cloudDeletedAt: "2026-09-01T00:00:00.000Z",
        cloudDeletionOperationId: "operation-web",
      }),
    ]);
  });

  it("stops init after retaining a Cloud-deleted project identity", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });
    const before = readProjectManifest(root)!;
    const deleted = {
      ...before,
      cloudDeletedAt: "2026-09-01T00:00:00.000Z",
      cloudDeletionOperationId: "operation-workspace",
    };
    writeProjectManifest(root, deleted);
    mkdirSync(join(root, "new-service", ".git"), { recursive: true });
    vi.mocked(console.log).mockClear();

    await initCommand({ cwd: root, multiRepo: true });

    expect(readProjectManifest(root)).toEqual(deleted);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("This project was deleted in ADIT Cloud.");
    expect(output).not.toContain("Setup");
    expect(output).not.toContain("Platforms");
    expect(output).not.toContain("Done! ADIT is ready.");
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

  it("upgrades a legacy schema 1 manifest on re-init without changing identity or members", async () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    const now = new Date().toISOString();
    writeProjectManifest(root, {
      schemaVersion: 1,
      projectId: "legacy-project",
      projectType: "workspace",
      repositories: [{ relativePath: "api", repositoryId: "id-api" }],
      createdAt: now,
      updatedAt: now,
    });

    await initCommand({ cwd: root });

    const manifest = readProjectManifest(root)!;
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.projectType).toBeUndefined();
    expect(manifest.projectId).toBe("legacy-project");
    expect(manifest.repositories).toEqual([{ relativePath: "api", repositoryId: "id-api" }]);
  });

  it("lets a single-repo project grow a sibling repository on re-init with --multi-repo", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mocks.getHeadSha.mockResolvedValue("abc123");
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");
    await initCommand({ cwd: root });
    const before = readProjectManifest(root)!;

    mkdirSync(join(root, "api", ".git"), { recursive: true });
    await initCommand({ cwd: root, multiRepo: true });

    const after = readProjectManifest(root)!;
    expect(after.projectId).toBe(before.projectId);
    expect(after.repositories.map((repo) => repo.relativePath)).toEqual([".", "api"]);
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

  describe("hook installation via CLI detection", () => {
    function fakeAdapter(platform: string, displayName: string, cliBinary?: string) {
      return {
        platform,
        displayName,
        cliBinary,
        hookMappings: [{ platformEvent: "Stop", aditHandler: "stop" }],
        installHooks: vi.fn(async () => {}),
        uninstallHooks: vi.fn(async () => {}),
        hasHooks: vi.fn(async () => false),
        validateInstallation: vi.fn(async () => ({ valid: true, checks: [] })),
      };
    }

    function registerFakes() {
      const claude = fakeAdapter("claude-code", "Claude Code", "claude");
      const vscode = fakeAdapter("claude-vscode", "Claude Code (VS Code)");
      const codex = fakeAdapter("codex", "Codex", "codex");
      const all = [claude, vscode, codex];
      mocks.listAdapters.mockReturnValue(all as never);
      mocks.getAdapter.mockImplementation(
        (platform: string) => {
          const adapter = all.find((entry) => entry.platform === platform);
          if (!adapter) throw new Error(`no adapter: ${platform}`);
          return adapter;
        },
      );
      return { claude, vscode, codex };
    }

    function readRecord(): string[] {
      return JSON.parse(readFileSync(join(root, ".adit", "platforms.json"), "utf-8")).connected;
    }

    it("connects all detected CLIs non-interactively and records them", async () => {
      mkdirSync(join(root, ".git"), { recursive: true });
      const { claude, vscode, codex } = registerFakes();
      mocks.detectInstalledPlatforms.mockReturnValue(["claude-code", "codex"] as never);

      await initCommand({ cwd: root });

      expect(claude.installHooks).toHaveBeenCalled();
      expect(vscode.installHooks).toHaveBeenCalled();
      expect(codex.installHooks).toHaveBeenCalled();
      expect(readRecord().sort()).toEqual(["claude-code", "claude-vscode", "codex"]);
    });

    it("re-init refreshes connected platforms and only adds new ones", async () => {
      mkdirSync(join(root, ".git"), { recursive: true });
      const { claude, vscode, codex } = registerFakes();
      mkdirSync(join(root, ".adit"), { recursive: true });
      writeFileSync(
        join(root, ".adit", "platforms.json"),
        JSON.stringify({ schemaVersion: 1, connected: ["claude-code", "claude-vscode"] }),
      );
      mocks.detectInstalledPlatforms.mockReturnValue(["claude-code", "codex"] as never);

      await initCommand({ cwd: root });

      // codex is new (installed); claude was connected (refreshed, not re-asked)
      expect(codex.installHooks).toHaveBeenCalledTimes(1);
      expect(claude.installHooks).toHaveBeenCalledTimes(1);
      expect(vscode.installHooks).toHaveBeenCalledTimes(1);
      expect(readRecord().sort()).toEqual(["claude-code", "claude-vscode", "codex"]);
    });

    it("records the platform on explicit --platform install", async () => {
      mkdirSync(join(root, ".git"), { recursive: true });
      const { codex } = registerFakes();

      await initCommand({ cwd: root, platform: "codex" });

      expect(codex.installHooks).toHaveBeenCalledTimes(1);
      expect(readRecord()).toEqual(["codex"]);
    });

    it("installs nothing and records nothing when no CLIs are detected", async () => {
      mkdirSync(join(root, ".git"), { recursive: true });
      const { claude, codex } = registerFakes();
      mocks.detectInstalledPlatforms.mockReturnValue([] as never);

      await initCommand({ cwd: root });

      expect(claude.installHooks).not.toHaveBeenCalled();
      expect(codex.installHooks).not.toHaveBeenCalled();
      expect(readRecord()).toEqual([]);
    });
  });
});
