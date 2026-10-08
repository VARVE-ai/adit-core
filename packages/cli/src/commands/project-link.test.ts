import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  loadConfig: vi.fn(),
  openDatabase: vi.fn(() => ({})),
  closeDatabase: vi.fn(),
  loadCloudConfig: vi.fn(() => ({ serverUrl: "https://cloud.example.com" })),
  loadCredentials: vi.fn(() => ({
    serverUrl: "https://cloud.example.com",
    accessToken: "token",
    refreshToken: null,
    expiresAt: null,
    clientId: "client-1",
    authType: "token",
  })),
  isTokenExpired: vi.fn(() => false),
  linkCommand: vi.fn(),
  healthGet: vi.fn(async () => ({ ok: true })),
  refreshDeletionPolicy: vi.fn(async () => null),
  getRemoteUrl: vi.fn(async () => "https://example.com/repo.git" as string | null),
  WorkspaceLinkPartialFailureError: class WorkspaceLinkPartialFailureError extends Error {
    readonly result: LinkResult;
    readonly repositoryResults: LinkResult["repositoryResults"];
    readonly repositoryFailures: LinkResult["repositoryFailures"];

    constructor(
      result: LinkResult,
      repositoryResults: LinkResult["repositoryResults"],
      repositoryFailures: LinkResult["repositoryFailures"],
    ) {
      super("Project link completed with repository failures.");
      this.name = "WorkspaceLinkPartialFailureError";
      this.result = result;
      this.repositoryResults = repositoryResults;
      this.repositoryFailures = repositoryFailures;
    }
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mocks.existsSync(...args),
  };
});

vi.mock("@varveai/adit-core", () => ({
  ProjectManifestError: class ProjectManifestError extends Error {
    constructor(
      message: string,
      public readonly manifestPath: string,
    ) {
      super(message);
    }
  },
  loadConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  openDatabase: (...args: unknown[]) => mocks.openDatabase(...args),
  closeDatabase: (...args: unknown[]) => mocks.closeDatabase(...args),
}));

vi.mock("@varveai/adit-engine", () => ({
  getRemoteUrl: (...args: unknown[]) => mocks.getRemoteUrl(...args),
}));

vi.mock("@varveai/adit-cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@varveai/adit-cloud")>();
  return {
    ...actual,
    loadCloudConfig: (...args: unknown[]) => mocks.loadCloudConfig(...args),
    loadCredentials: (...args: unknown[]) => mocks.loadCredentials(...args),
    isTokenExpired: (...args: unknown[]) => mocks.isTokenExpired(...args),
    CloudClient: vi.fn(function CloudClient() {
      return {
        get: mocks.healthGet,
      };
    }),
    WorkspaceLinkPartialFailureError: mocks.WorkspaceLinkPartialFailureError,
    refreshProjectDeletionPolicy: (...args: unknown[]) =>
      mocks.refreshDeletionPolicy(...args),
    linkCommand: (...args: unknown[]) => mocks.linkCommand(...args),
    DEFAULT_SERVER_URL: "https://default.example.com",
  };
});

import type { LinkResult } from "@varveai/adit-cloud";
import { projectLinkCliHandler } from "./project-link.js";

function workspaceConfig() {
  return {
    projectType: "workspace",
    projectRoot: "/workspace",
    projectId: "workspace-id",
    dbPath: "/workspace/.adit/adit.sqlite",
    initialization: "initialized",
    repositories: [
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        displayName: "a",
        repositoryUrl: null,
        canonicalRepoKey: null,
        path: "/workspace/a",
      },
      {
        localRepositoryId: "repo-b",
        relativePath: "b",
        displayName: "b",
        repositoryUrl: null,
        canonicalRepoKey: null,
        path: "/workspace/b",
      },
    ],
  };
}

function makeWorkspaceResult(): LinkResult {
  return {
    projectId: "server-project",
    localProjectId: "workspace-id",
    localRepositoryId: "*",
    relativePath: "*",
    serverProjectId: "server-project",
    projectName: "workspace",
    canonicalRepoKey: null,
    serverUrl: "https://cloud.example.com",
    branchCount: 1,
    commitCount: 2,
    documentCount: 3,
    stepTimings: [],
    totalDurationMs: 100,
    repositoryResults: [{
      localRepositoryId: "repo-b",
      relativePath: "b",
      branchCount: 1,
      commitCount: 2,
      documentCount: 3,
      totalDurationMs: 80,
    }],
    repositoryFailures: [{
      localRepositoryId: "repo-a",
      relativePath: "a",
      message: "No git remote 'origin' configured for a.",
    }],
  };
}

describe("projectLinkCliHandler", () => {
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");
    process.exitCode = undefined;
    originalLog = console.log;
    originalError = console.error;
    console.log = vi.fn() as never;
    console.error = vi.fn() as never;
    mocks.loadConfig.mockReturnValue(workspaceConfig());
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = undefined;
  });

  it("does not refresh or apply Cloud deletion policy during a dry run", async () => {
    mocks.linkCommand.mockResolvedValue(makeWorkspaceResult());
    await projectLinkCliHandler({ dryRun: true, force: true, silent: true });
    expect(mocks.refreshDeletionPolicy).not.toHaveBeenCalled();
    expect(mocks.linkCommand).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/workspace", "workspace-id",
      "https://cloud.example.com", expect.objectContaining({ dryRun: true, force: true }));
    expect(process.exitCode).toBeUndefined();
  });

  it("sets a failing exit code and closes with one summary for workspace partial failure", async () => {
    const result = makeWorkspaceResult();
    mocks.linkCommand.mockRejectedValue(
      new mocks.WorkspaceLinkPartialFailureError(
        result,
        result.repositoryResults ?? [],
        result.repositoryFailures ?? [],
      ),
    );

    await projectLinkCliHandler({});

    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(errors.filter((line) => line.includes("failed to link"))).toEqual(["✗ 1 of 2 repositories failed to link"]);
  });

  it("prints structured JSON for workspace partial failure in JSON mode", async () => {
    const result = makeWorkspaceResult();
    mocks.linkCommand.mockRejectedValue(
      new mocks.WorkspaceLinkPartialFailureError(
        result,
        result.repositoryResults ?? [],
        result.repositoryFailures ?? [],
      ),
    );

    await projectLinkCliHandler({ json: true });

    expect(process.exitCode).toBe(1);
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("stops before auth, health check, or database open when the current project is not initialized", async () => {
    mocks.loadConfig.mockReturnValue({
      projectType: "repo",
      projectRoot: "/workspace/repo",
      projectId: "",
      dbPath: "/workspace/repo/.adit/adit.sqlite",
      initialization: "uninitialized",
      repositories: [],
    });

    await projectLinkCliHandler({});

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.map((call) => String(call[0]))).toEqual([
      "✗ link: ADIT is not initialized in this project",
      "  run adit init, then retry adit cloud link",
    ]);
    expect(mocks.loadCredentials).not.toHaveBeenCalled();
    expect(mocks.healthGet).not.toHaveBeenCalled();
    expect(mocks.openDatabase).not.toHaveBeenCalled();
    expect(mocks.linkCommand).not.toHaveBeenCalled();
  });

  it("lists every active repository missing an origin after refreshing deletion policy", async () => {
    mocks.getRemoteUrl.mockResolvedValue(null);

    await projectLinkCliHandler({});

    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(errors.some((line) => line.includes("✗ a  no git remote 'origin'"))).toBe(true);
    expect(errors.some((line) => line.includes("✗ b  no git remote 'origin'"))).toBe(true);
    expect(mocks.loadCredentials).toHaveBeenCalled();
    expect(mocks.healthGet).toHaveBeenCalled();
    expect(mocks.refreshDeletionPolicy).toHaveBeenCalled();
    expect(mocks.linkCommand).not.toHaveBeenCalled();
  });

  it("points at re-running init when an active registered repository is missing", async () => {
    mocks.existsSync.mockImplementation(
      (path: unknown) => !String(path).replace(/\\/gu, "/").includes("/workspace/a"),
    );

    await projectLinkCliHandler({});

    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(errors.some((line) => line.includes("✗ a  missing or no longer a Git repository"))).toBe(true);
    expect(errors.some((line) => line.includes("re-run adit init if the repository list changed"))).toBe(true);
    expect(mocks.loadCredentials).toHaveBeenCalled();
    expect(mocks.linkCommand).not.toHaveBeenCalled();
  });

  it("shows repositories that link marked as deleted in Cloud", async () => {
    const before = workspaceConfig();
    const after = {
      ...before,
      repositories: before.repositories.filter((repository) => repository.relativePath === "b"),
    };
    mocks.loadConfig.mockReturnValueOnce(before).mockReturnValue(after);
    mocks.refreshDeletionPolicy.mockResolvedValue({
      localProjectId: "workspace-id",
      projectDeleted: false,
      deletionOperationId: null,
      deletedAt: null,
      deletedRepositories: [{
        deletionOperationId: "operation-a",
        localRepositoryId: "repo-a",
        relativePath: "a",
        deletedAt: "2026-09-01T00:00:00.000Z",
      }],
    });
    mocks.linkCommand.mockResolvedValue(makeWorkspaceResult());

    await projectLinkCliHandler({});

    const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("Deleted") && line.includes("a · deleted in Cloud, not linked"))).toBe(true);
    expect(mocks.getRemoteUrl).toHaveBeenCalledTimes(1);
  });
});
