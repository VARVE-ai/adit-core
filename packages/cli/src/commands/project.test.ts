/**
 * Tests for `adit project` lifecycle commands.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  listCheckpointRefs: vi.fn(),
  deleteCheckpointRef: vi.fn(),
  uninstallInstalledPlatformHooks: vi.fn(),
}));

vi.mock("@varveai/adit-core", () => ({
  ProjectManifestError: class ProjectManifestError extends Error {
    constructor(
      message: string,
      public readonly manifestPath: string,
    ) {
      super(message);
    }
  },
  loadConfig: mocks.loadConfig,
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  rmSync: mocks.rmSync,
}));

vi.mock("@varveai/adit-engine", () => ({
  listCheckpointRefs: mocks.listCheckpointRefs,
  deleteCheckpointRef: mocks.deleteCheckpointRef,
}));

vi.mock("./plugin.js", () => ({
  uninstallInstalledPlatformHooks: mocks.uninstallInstalledPlatformHooks,
}));

import { projectUninstallCommand, uninstallProject } from "./project.js";

describe("project uninstall command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    // dbPath must be present and "exist": projectUninstallCommand runs the
    // loadInitializedProjectConfig guard first, which checks existsSync(dbPath)
    // and silently early-returns (via console.error) when it's missing.
    mocks.loadConfig.mockReturnValue({
      projectRoot: "/repo",
      dataDir: "/repo/.adit",
      dbPath: "/repo/.adit/adit.sqlite",
      initialization: "initialized",
      repositories: [],
    });
    mocks.existsSync.mockImplementation((path: string) =>
      path === "/repo/.adit" ||
      path === "/repo/.adit/adit.sqlite" ||
      path === "/repo/.claude/skills/generate-docs.md"
    );
    mocks.listCheckpointRefs.mockResolvedValue([
      { stepId: "evt-1", sha: "abc" },
      { stepId: "evt-2", sha: "def" },
    ]);
    mocks.deleteCheckpointRef.mockResolvedValue(true);
    mocks.uninstallInstalledPlatformHooks.mockResolvedValue({
      uninstalled: ["Codex CLI"],
      errors: [],
    });
  });

  it("requires --yes before uninstalling local project data", async () => {
    await projectUninstallCommand({ json: true });

    expect(mocks.uninstallInstalledPlatformHooks).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.deleteCheckpointRef).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not mention legacy checkpoint refs in the confirmation prompt", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    try {
      await projectUninstallCommand();
    } finally {
      spy.mockRestore();
    }

    const output = logs.join("\n");
    expect(output).toContain("remove installed ADIT hooks and delete the local .adit/ data directory");
    expect(output).not.toContain("checkpoint refs");
    expect(output).not.toContain("refs/adit/checkpoints");
  });

  it("removes hooks, init-generated files, data directory, and checkpoint refs", async () => {
    const result = await uninstallProject("/repo", "/repo/.adit");

    expect(mocks.uninstallInstalledPlatformHooks).toHaveBeenCalledWith("/repo");
    expect(mocks.rmSync).toHaveBeenCalledWith("/repo/.claude/skills/generate-docs.md", {
      force: true,
    });
    expect(mocks.rmSync).toHaveBeenCalledWith("/repo/.adit", {
      recursive: true,
      force: true,
    });
    expect(mocks.deleteCheckpointRef).toHaveBeenCalledWith("/repo", "evt-1");
    expect(mocks.deleteCheckpointRef).toHaveBeenCalledWith("/repo", "evt-2");
    expect(result).toMatchObject({
      ok: true,
      uninstalled: ["Codex CLI"],
      dataRemoved: true,
      generatedFilesRemoved: 1,
      checkpointRefsRemoved: 2,
    });
  });

  it("outputs JSON for scripted uninstall", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    try {
      await projectUninstallCommand({ yes: true, json: true });
    } finally {
      spy.mockRestore();
    }

    const parsed = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      action: string;
      dataRemoved: boolean;
      generatedFilesRemoved: number;
      checkpointRefsRemoved: number;
    };
    expect(parsed).toEqual(expect.objectContaining({
      ok: true,
      action: "project-uninstall",
      dataRemoved: true,
      generatedFilesRemoved: 1,
      checkpointRefsRemoved: 2,
    }));
  });

  it("silently removes legacy checkpoint refs in human-readable uninstall output", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    try {
      await projectUninstallCommand({ yes: true });
    } finally {
      spy.mockRestore();
    }

    const output = logs.join("\n");
    expect(mocks.deleteCheckpointRef).toHaveBeenCalledWith("/repo", "evt-1");
    expect(mocks.deleteCheckpointRef).toHaveBeenCalledWith("/repo", "evt-2");
    expect(output).not.toContain("checkpoint ref");
    expect(output).not.toContain("refs/adit/checkpoints");
  });
});
