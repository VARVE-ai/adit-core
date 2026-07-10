import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  loadConfig: vi.fn(),
  openDatabase: vi.fn(() => ({})),
  closeDatabase: vi.fn(),
  discoverWorkspaceRepositories: vi.fn(() => [{ relativePath: "repo" }]),
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
  isGitRepo: vi.fn(async () => true),
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
  loadConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  openDatabase: (...args: unknown[]) => mocks.openDatabase(...args),
  closeDatabase: (...args: unknown[]) => mocks.closeDatabase(...args),
  discoverWorkspaceRepositories: (...args: unknown[]) => mocks.discoverWorkspaceRepositories(...args),
}));

vi.mock("@varveai/adit-engine", () => ({
  isGitRepo: (...args: unknown[]) => mocks.isGitRepo(...args),
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
    process.exitCode = undefined;
    originalLog = console.log;
    originalError = console.error;
    console.log = vi.fn() as never;
    console.error = vi.fn() as never;
    mocks.loadConfig.mockReturnValue({
      projectType: "workspace",
      projectRoot: "/workspace",
      projectId: "workspace-id",
      dbPath: "/workspace/.adit/adit.sqlite",
    });
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
      projectId: "repo-id",
      dbPath: "/workspace/repo/.adit/adit.sqlite",
    });
    mocks.existsSync.mockReturnValue(false);

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
});
