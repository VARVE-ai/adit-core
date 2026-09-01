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
      super("Workspace link completed with repository failures.");
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
    qualified: false,
    score: null,
    stepTimings: [],
    totalDurationMs: 100,
    repositoryResults: [{
      localRepositoryId: "repo-b",
      relativePath: "b",
      branchCount: 1,
      commitCount: 2,
      documentCount: 3,
      qualified: false,
      score: null,
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

  it("sets a failing exit code without duplicate error output for workspace partial failure", async () => {
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
    expect(console.error).not.toHaveBeenCalled();
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
    expect(console.error).toHaveBeenCalledWith([
      "ADIT is not initialized in this project.",
      "",
      "Run:",
      "  adit init",
      "",
      "Then retry:",
      "  adit cloud link",
    ].join("\n"));
    expect(mocks.loadCredentials).not.toHaveBeenCalled();
    expect(mocks.healthGet).not.toHaveBeenCalled();
    expect(mocks.openDatabase).not.toHaveBeenCalled();
    expect(mocks.linkCommand).not.toHaveBeenCalled();
  });

  it("lists every repository missing an origin before any auth or network call", async () => {
    mocks.getRemoteUrl.mockResolvedValue(null);

    await projectLinkCliHandler({});

    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(errors.some((line) => line.includes("a: no git remote 'origin'"))).toBe(true);
    expect(errors.some((line) => line.includes("b: no git remote 'origin'"))).toBe(true);
    expect(mocks.loadCredentials).not.toHaveBeenCalled();
    expect(mocks.healthGet).not.toHaveBeenCalled();
    expect(mocks.linkCommand).not.toHaveBeenCalled();
  });

  it("stops before auth and points at re-running init when a registered repository is missing", async () => {
    mocks.existsSync.mockImplementation((path: unknown) => !String(path).includes("/workspace/a"));

    await projectLinkCliHandler({});

    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(errors.some((line) => line.includes("a: repository is missing"))).toBe(true);
    expect(errors.some((line) => line.includes("re-run 'adit init'"))).toBe(true);
    expect(mocks.loadCredentials).not.toHaveBeenCalled();
    expect(mocks.linkCommand).not.toHaveBeenCalled();
  });
});
