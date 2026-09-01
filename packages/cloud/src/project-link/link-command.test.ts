import { describe, expect, it, vi } from "vitest";
import type { GitCommit } from "./types.js";
import { CloudApiError } from "../http/errors.js";

const mockLoadConfig = vi.fn();
const mockResolveCloudProjectContext = vi.fn();
const mockGetProjectLinkCache = vi.fn();
const mockUpsertProjectLinkCache = vi.fn();
const mockCollectBranches = vi.fn();
const mockCollectRemoteBranchSnapshot = vi.fn(async () => ({
  branches: [{ name: "main", headSha: "abc", isDefault: true }],
  fingerprint: "remote-main",
}));
const mockCollectDefaultBranch = vi.fn();
const mockCollectGitIdentity = vi.fn();
const mockCollectCommitLogs = vi.fn();
const mockCollectCommitCount = vi.fn();
const mockCollectCommitFileStats = vi.fn();
const mockResolveCommitBranches = vi.fn();
const mockCollectGitRefsFingerprint = vi.fn();
const mockDiscoverDocuments = vi.fn();
const mockCheckQuality = vi.fn();

vi.mock("@varveai/adit-core", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../project-context.js", () => ({
  resolveCloudProjectContext: (...args: unknown[]) => mockResolveCloudProjectContext(...args),
  repositoryPayloads: (repositories: Array<{
    localRepositoryId: string;
    relativePath: string;
    displayName?: string;
    repositoryUrl?: string | null;
    canonicalRepoKey?: string | null;
  }>) => repositories.map((repository) => ({
    localRepositoryId: repository.localRepositoryId,
    relativePath: repository.relativePath,
    displayName: repository.displayName,
    ...(repository.repositoryUrl ? { repositoryUrl: repository.repositoryUrl } : {}),
    ...(repository.canonicalRepoKey ? { canonicalRepoKey: repository.canonicalRepoKey } : {}),
  })),
}));

vi.mock("../project-deletion-policy.js", () => ({
  refreshProjectDeletionPolicy: vi.fn(async () => null),
  CloudProjectDeletedError: class CloudProjectDeletedError extends Error {},
}));

vi.mock("./cache.js", () => ({
  getProjectLinkCache: (...args: unknown[]) => mockGetProjectLinkCache(...args),
  upsertProjectLinkCache: (...args: unknown[]) => mockUpsertProjectLinkCache(...args),
  clearProjectLinkCache: vi.fn(),
  updateCachedCommitSha: vi.fn(),
  updateCachedDocHashes: vi.fn(),
  updateCachedQualified: vi.fn(),
}));

vi.mock("./git-collector.js", () => ({
  collectBranches: (...args: unknown[]) => mockCollectBranches(...args),
  collectRemoteBranchSnapshot: (...args: unknown[]) => mockCollectRemoteBranchSnapshot(...args),
  collectDefaultBranch: (...args: unknown[]) => mockCollectDefaultBranch(...args),
  collectGitIdentity: (...args: unknown[]) => mockCollectGitIdentity(...args),
  collectCommitLogs: (...args: unknown[]) => mockCollectCommitLogs(...args),
  collectCommitCount: (...args: unknown[]) => mockCollectCommitCount(...args),
  collectCommitFileStats: (...args: unknown[]) => mockCollectCommitFileStats(...args),
  resolveCommitBranches: (...args: unknown[]) => mockResolveCommitBranches(...args),
  collectGitRefsFingerprint: (...args: unknown[]) => mockCollectGitRefsFingerprint(...args),
  branchHeadMap: (branches: Array<{ name: string; headSha: string }>) =>
    Object.fromEntries(branches.map((branch) => [branch.name, branch.headSha])),
  projectNameFromRemoteUrl: vi.fn(() => "repo-name"),
}));

vi.mock("./doc-discovery.js", () => ({
  discoverDocuments: (...args: unknown[]) => mockDiscoverDocuments(...args),
  loadDocSettings: vi.fn(() => undefined),
}));

vi.mock("./qualify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qualify.js")>();
  return {
    ...actual,
    checkQuality: (...args: unknown[]) => mockCheckQuality(...args),
  };
});

import { linkCommand, WorkspaceLinkPartialFailureError } from "./link-command.js";

interface TestRepository {
  localRepositoryId: string;
  relativePath: string;
  displayName: string;
  path: string;
  repositoryUrl: string | null;
  canonicalRepoKey: string | null;
}

function makeCommit(sha: string, message = `Commit ${sha}`): GitCommit {
  return {
    sha,
    parentSha: null,
    authorName: "Test User",
    authorEmail: "test@example.com",
    date: "2026-01-01T00:00:00.000Z",
    message,
    branch: "main",
  };
}

function setupWorkspaceLinkTest(repositories: TestRepository[], commitsByPath: Record<string, GitCommit[]>) {
  const commitRequests: Array<{
    localRepositoryId: string;
    relativePath: string;
    commits: Array<{ sha: string }>;
  }> = [];
  const client = {
    post: vi.fn(async (path: string, body?: {
      localRepositoryId?: string;
      relativePath?: string;
      commits?: Array<{ sha: string }>;
    }) => {
      if (path === "/api/project-link/negotiate") {
        return {
          confirmedProjectId: "server-project",
          projectName: "workspace-root",
          status: "confirmed",
        };
      }
      if (path === "/api/project-link/init") {
        return { projectLink: { branchCount: 1 } };
      }
      if (path === "/api/project-link/commits") {
        commitRequests.push({
          localRepositoryId: body?.localRepositoryId ?? "",
          relativePath: body?.relativePath ?? "",
          commits: (body?.commits ?? []).map((commit) => ({ sha: commit.sha })),
        });
        return {
          accepted: body?.commits?.length ?? 0,
          totalCommits: body?.commits?.length ?? 0,
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    }),
    get: vi.fn(),
    delete: vi.fn(),
  };

  mockLoadConfig.mockReturnValue({ projectRoot: "/workspace" });
  mockResolveCloudProjectContext.mockResolvedValue({
    projectType: "workspace",
    localProjectId: "workspace-id",
    projectRoot: "/workspace",
    projectName: "workspace-root",
    remoteUrl: null,
    canonicalRepoKey: null,
    repositories,
  });
  mockGetProjectLinkCache.mockReturnValue(null);
  mockCollectBranches.mockResolvedValue([{ name: "main", headSha: "abc", isDefault: true }]);
  mockCollectDefaultBranch.mockResolvedValue("main");
  mockCollectGitIdentity.mockResolvedValue({ authorName: null, authorEmail: null });
  mockCollectCommitLogs.mockImplementation((repoPath: string) => Promise.resolve(commitsByPath[repoPath] ?? []));
  mockCollectCommitCount.mockImplementation((repoPath: string) => Promise.resolve(commitsByPath[repoPath]?.length ?? 0));
  mockCollectCommitFileStats.mockResolvedValue(new Map());
  mockResolveCommitBranches.mockResolvedValue(undefined);
  mockCollectGitRefsFingerprint.mockResolvedValue(null);
  mockDiscoverDocuments.mockReturnValue([]);
  mockCheckQuality.mockResolvedValue({
    qualified: true,
    score: 0.82,
    documentCount: 0,
    feedback: null,
  });

  return { client, commitRequests };
}

describe("linkCommand workspace repository requests", () => {
  it("prints compact workspace output instead of per-repository summaries", async () => {
    const repositories = [
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        displayName: "a",
        path: "/workspace/a",
        repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      },
      {
        localRepositoryId: "repo-b",
        relativePath: "b",
        displayName: "b",
        path: "/workspace/b",
        repositoryUrl: "git@github.com:VARVE-ai/adit-cloud.git",
        canonicalRepoKey: "github:varve-ai/adit-cloud",
      },
    ];
    const { client } = setupWorkspaceLinkTest(repositories, {
      "/workspace/a": [makeCommit("sha-a")],
      "/workspace/b": [makeCommit("sha-b")],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const result = await linkCommand(
        {} as never,
        client as never,
        "/workspace",
        "workspace-id",
        "https://cloud.example.com",
        { skipDocs: true, skipQualify: true },
      );

      const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(output.match(/Workspace link complete!/gu)).toHaveLength(1);
      expect(output).not.toContain("Project link complete!");
      expect(output).not.toContain("[Step 1/6]");
      expect(output).toContain("[1/2] a linking...");
      expect(output).toContain("[2/2] b linking...");
      expect(output).toContain("[1/2] a ok | branches 1 | commits 1 | docs 0 | not qualified");
      expect(output).toContain("[2/2] b ok | branches 1 | commits 1 | docs 0 | not qualified");
      expect(output).toContain("Repositories: 2 succeeded, 0 failed");
      expect(result.repositoryResults).toHaveLength(2);
      expect(result.repositoryFailures).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the full summary and detailed quality feedback for normal repo projects", async () => {
    const client = {
      post: vi.fn(async (path: string) => {
        if (path === "/api/project-link/negotiate") {
          return {
            confirmedProjectId: "server-project",
            projectName: "repo-name",
            status: "confirmed",
          };
        }
        if (path === "/api/project-link/init") {
          return { projectLink: { branchCount: 1 } };
        }
        if (path === "/api/project-link/commits") {
          return { accepted: 0, totalCommits: 0 };
        }
        throw new Error(`Unexpected path: ${path}`);
      }),
      get: vi.fn(),
      delete: vi.fn(),
    };
    mockLoadConfig.mockReturnValue({ projectRoot: "/repo" });
    mockResolveCloudProjectContext.mockResolvedValue({
      projectType: "repo",
      localProjectId: "repo-id",
      projectRoot: "/repo",
      projectName: "repo-name",
      remoteUrl: "git@github.com:VARVE-ai/adit-core.git",
      canonicalRepoKey: "github:varve-ai/adit-core",
      repositories: [{
        localRepositoryId: "repo-id",
        relativePath: ".",
        displayName: "repo-name",
        path: "/repo",
        repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      }],
    });
    mockGetProjectLinkCache.mockReturnValue(null);
    mockCollectBranches.mockResolvedValue([{ name: "main", headSha: "abc", isDefault: true }]);
    mockCollectDefaultBranch.mockResolvedValue("main");
    mockCollectGitIdentity.mockResolvedValue({ authorName: null, authorEmail: null });
    mockCollectCommitLogs.mockResolvedValue([]);
    mockCollectCommitCount.mockResolvedValue(0);
    mockCollectCommitFileStats.mockResolvedValue(new Map());
    mockResolveCommitBranches.mockResolvedValue(undefined);
    mockCollectGitRefsFingerprint.mockResolvedValue(null);
    mockDiscoverDocuments.mockReturnValue([{
      fileName: "README.md",
      sourcePath: "README.md",
      content: "# Project\n\n## Purpose\nUseful context.",
      contentHash: "hash-1",
      sizeBytes: 32,
      status: "unchanged",
    }]);
    mockCheckQuality.mockResolvedValue({
      qualified: false,
      score: 0.4,
      documentCount: 1,
      documentDetails: [{
        fileName: "README.md",
        detectedType: "project-overview",
        structuralScore: 0.4,
        missingSections: ["Architecture"],
        hasStubContent: true,
      }],
      feedback: {
        missing: ["Architecture overview"],
        suggestions: ["Ask your AI agent to read .adit/prompts/generate-docs.md and follow it to fill missing sections."],
        summaryPrompt: "Read .adit/prompts/generate-docs.md, fill the docs, then re-run link.",
      },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await linkCommand(
        {} as never,
        client as never,
        "/repo",
        "repo-id",
        "https://cloud.example.com",
        {},
      );

      const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(output).toContain("[Step 1/6] Negotiating project ID with server...");
      expect(output).toContain("Document scores:");
      expect(output).toContain("Missing:");
      expect(output).toContain("Suggestions:");
      expect(output).toContain("Read .adit/prompts/generate-docs.md, fill the docs, then re-run link.");
      expect(output).toContain("Project link complete!");
      expect(output).not.toContain("Workspace link complete!");
      expect(output).not.toContain("Quality feedback:");
      expect(output).not.toContain("Repository  Quality");
    } finally {
      log.mockRestore();
    }
  });

  it("re-uploads branches inside the cooldown window when local or remote refs changed", async () => {
    const makeClient = () => ({
      post: vi.fn(async (path: string) => {
        if (path === "/api/project-link/negotiate") {
          return {
            confirmedProjectId: "server-project",
            projectName: "repo-name",
            status: "confirmed",
          };
        }
        if (path === "/api/project-link/init") {
          return { projectLink: { branchCount: 1 } };
        }
        throw new Error(`Unexpected path: ${path}`);
      }),
      get: vi.fn(),
      delete: vi.fn(),
    });
    const freshCache = () => ({
      projectId: "repo-id",
      repositoryId: "repo-id",
      serverUrl: "https://cloud.example.com",
      confirmedProjectId: "server-project",
      gitRefHeads: { main: "abc" },
      gitRefsFingerprint: "fingerprint-old",
      remoteRefsFingerprint: "remote-main",
      lastRemoteBranchCheckAt: new Date().toISOString(),
      lastBranchSyncAt: new Date().toISOString(),
      lastDocSyncAt: null,
      docHashes: {},
      qualified: true,
      initializedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mockLoadConfig.mockReturnValue({ projectRoot: "/repo" });
    mockResolveCloudProjectContext.mockResolvedValue({
      projectType: "repo",
      localProjectId: "repo-id",
      projectRoot: "/repo",
      projectName: "repo-name",
      remoteUrl: "git@github.com:VARVE-ai/adit-core.git",
      canonicalRepoKey: "github:varve-ai/adit-core",
      repositories: [{
        localRepositoryId: "repo-id",
        relativePath: ".",
        displayName: "repo-name",
        path: "/repo",
        repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      }],
    });
    mockCollectBranches.mockResolvedValue([{ name: "main", headSha: "abc", isDefault: true }]);
    mockCollectDefaultBranch.mockResolvedValue("main");
    mockCollectGitIdentity.mockResolvedValue({ authorName: null, authorEmail: null });
    const options = { skipCommits: true, skipDocs: true, skipQualify: true };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      // Same fingerprint inside the cooldown window → branch upload skipped.
      mockGetProjectLinkCache.mockReturnValue(freshCache());
      mockCollectGitRefsFingerprint.mockResolvedValue("fingerprint-old");
      const unchangedClient = makeClient();
      await linkCommand(
        {} as never,
        unchangedClient as never,
        "/repo",
        "repo-id",
        "https://cloud.example.com",
        options,
      );
      expect(unchangedClient.post).not.toHaveBeenCalledWith(
        "/api/project-link/init",
        expect.anything(),
      );

      // Changed fingerprint bypasses the cooldown → branches upload again.
      mockGetProjectLinkCache.mockReturnValue(freshCache());
      mockCollectGitRefsFingerprint.mockResolvedValue("fingerprint-new");
      const changedClient = makeClient();
      await linkCommand(
        {} as never,
        changedClient as never,
        "/repo",
        "repo-id",
        "https://cloud.example.com",
        options,
      );
      expect(changedClient.post).toHaveBeenCalledWith(
        "/api/project-link/init",
        expect.objectContaining({
          branches: [{ name: "main", headSha: "abc" }],
        }),
      );

      // A remote-only change also bypasses the cooldown.
      mockGetProjectLinkCache.mockReturnValue(freshCache());
      mockCollectGitRefsFingerprint.mockResolvedValue("fingerprint-old");
      mockCollectRemoteBranchSnapshot.mockResolvedValueOnce({
        branches: [{ name: "main", headSha: "remote-new", isDefault: true }],
        fingerprint: "remote-new",
      });
      const remoteChangedClient = makeClient();
      await linkCommand(
        {} as never,
        remoteChangedClient as never,
        "/repo",
        "repo-id",
        "https://cloud.example.com",
        options,
      );
      expect(remoteChangedClient.post).toHaveBeenCalledWith(
        "/api/project-link/init",
        expect.objectContaining({
          remoteBranchSnapshot: {
            branches: [{ name: "main", headSha: "remote-new" }],
          },
        }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("continues workspace linking after a repository failure and exposes structured failures", async () => {
    const repositories = [
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        displayName: "a",
        path: "/workspace/a",
        repositoryUrl: null,
        canonicalRepoKey: null,
      },
      {
        localRepositoryId: "repo-b",
        relativePath: "b",
        displayName: "b",
        path: "/workspace/b",
        repositoryUrl: "git@github.com:VARVE-ai/adit-cloud.git",
        canonicalRepoKey: "github:varve-ai/adit-cloud",
      },
    ];
    const { client } = setupWorkspaceLinkTest(repositories, {
      "/workspace/b": [makeCommit("sha-b")],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(linkCommand(
        {} as never,
        client as never,
        "/workspace",
        "workspace-id",
        "https://cloud.example.com",
        { skipDocs: true, skipQualify: true },
      )).rejects.toMatchObject({
        repositoryResults: [
          expect.objectContaining({ relativePath: "b", localRepositoryId: "repo-b" }),
        ],
        repositoryFailures: [
          expect.objectContaining({
            relativePath: "a",
            localRepositoryId: "repo-a",
            step: "Negotiate project ID",
            message: "No git remote 'origin' configured for a.",
          }),
        ],
      });

      const error = await linkCommand(
        {} as never,
        client as never,
        "/workspace",
        "workspace-id",
        "https://cloud.example.com",
        { skipDocs: true, skipQualify: true, json: true },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WorkspaceLinkPartialFailureError);
      expect((error as WorkspaceLinkPartialFailureError).result.repositoryFailures).toHaveLength(1);

      const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(output).toContain("[1/2] a failed | Negotiate project ID: No git remote 'origin' configured for a.");
      expect(output).toContain("[2/2] b ok | branches 1 | commits 1 | docs 0 | not qualified");
      expect(output).toContain("Repositories: 1 succeeded, 1 failed");
      expect(output).toContain("Failures:");
      expect(output).toContain("a: Negotiate project ID: No git remote 'origin' configured for a.");
    } finally {
      log.mockRestore();
    }
  });

  it("includes the failed step and API response body for workspace API errors", async () => {
    const repositories = [
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        displayName: "a",
        path: "/workspace/a",
        repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      },
      {
        localRepositoryId: "repo-b",
        relativePath: "b",
        displayName: "b",
        path: "/workspace/b",
        repositoryUrl: "git@github.com:VARVE-ai/adit-cloud.git",
        canonicalRepoKey: "github:varve-ai/adit-cloud",
      },
    ];
    const { client } = setupWorkspaceLinkTest(repositories, {
      "/workspace/b": [makeCommit("sha-b")],
    });
    client.post.mockImplementation(async (path: string, body?: {
      localRepositoryId?: string;
      relativePath?: string;
      commits?: Array<{ sha: string }>;
    }) => {
      if (path === "/api/project-link/negotiate") {
        return {
          confirmedProjectId: "server-project",
          projectName: "workspace-root",
          status: "confirmed",
        };
      }
      if (path === "/api/project-link/init" && body?.relativePath === "a") {
        throw new CloudApiError("API error: 400 Bad Request", 400, {
          message: "relativePath is not registered for this workspace",
        });
      }
      if (path === "/api/project-link/init") {
        return { projectLink: { branchCount: 1 } };
      }
      if (path === "/api/project-link/commits") {
        return {
          accepted: body?.commits?.length ?? 0,
          totalCommits: body?.commits?.length ?? 0,
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const error = await linkCommand(
        {} as never,
        client as never,
        "/workspace",
        "workspace-id",
        "https://cloud.example.com",
        { skipDocs: true, skipQualify: true },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WorkspaceLinkPartialFailureError);
      expect((error as WorkspaceLinkPartialFailureError).repositoryFailures).toEqual([
        expect.objectContaining({
          relativePath: "a",
          step: "Upload branches",
          status: 400,
          response: {
            message: "relativePath is not registered for this workspace",
          },
        }),
      ]);

      const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(output).toContain(
        "[1/2] a failed | Upload branches: API error 400: Bad Request | relativePath is not registered for this workspace",
      );
      expect(output).toContain("[2/2] b ok | branches 1 | commits 1 | docs 0 | not qualified");
      expect(output).toContain(
        "a: Upload branches: API error 400: Bad Request | relativePath is not registered for this workspace",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("suppresses human-readable workspace output in JSON mode", async () => {
    const repositories = [{
      localRepositoryId: "repo-a",
      relativePath: "a",
      displayName: "a",
      path: "/workspace/a",
      repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
      canonicalRepoKey: "github:varve-ai/adit-core",
    }];
    const { client } = setupWorkspaceLinkTest(repositories, {
      "/workspace/a": [makeCommit("sha-a")],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await linkCommand(
        {} as never,
        client as never,
        "/workspace",
        "workspace-id",
        "https://cloud.example.com",
        { skipDocs: true, skipQualify: true, json: true },
      );

      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("prints repository and workspace quality scores when quality check runs", async () => {
    const repositories = [{
      localRepositoryId: "repo-a",
      relativePath: "a",
      displayName: "a",
      path: "/workspace/a",
      repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
      canonicalRepoKey: "github:varve-ai/adit-core",
    }];
    const { client } = setupWorkspaceLinkTest(repositories, {
      "/workspace/a": [makeCommit("sha-a")],
    });
    mockDiscoverDocuments.mockReturnValue([{
      fileName: "README.md",
      sourcePath: "README.md",
      content: "# Project\n\n## Purpose\nUseful context.",
      contentHash: "hash-1",
      sizeBytes: 32,
      status: "unchanged",
    }]);
    mockCheckQuality.mockResolvedValue({
      qualified: true,
      score: 0.88,
      documentCount: 1,
      feedback: null,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const result = await linkCommand(
        {} as never,
        client as never,
        "/workspace",
        "workspace-id",
        "https://cloud.example.com",
        {},
      );

      const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(output).toContain("[1/1] a ok | branches 1 | commits 1 | docs 1 | qualified, score 0.88");
      expect(output).toContain("Documents:    1 (qualified, score 0.88)");
      expect(result.score).toBe(0.88);
      expect(result.repositoryResults?.[0]?.score).toBe(0.88);
    } finally {
      log.mockRestore();
    }
  });

  it("prints workspace quality feedback and summary prompts when documents are not qualified", async () => {
    const repositories = [{
      localRepositoryId: "repo-a",
      relativePath: "a",
      displayName: "a",
      path: "/workspace/a",
      repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
      canonicalRepoKey: "github:varve-ai/adit-core",
    }];
    const { client } = setupWorkspaceLinkTest(repositories, {
      "/workspace/a": [makeCommit("sha-a")],
    });
    mockDiscoverDocuments.mockReturnValue([{
      fileName: "README.md",
      sourcePath: "README.md",
      content: "# Project\n\n## Purpose\nUseful context.",
      contentHash: "hash-1",
      sizeBytes: 32,
      status: "unchanged",
    }]);
    mockCheckQuality.mockResolvedValue({
      qualified: false,
      score: 0.41,
      documentCount: 1,
      documentDetails: [{
        fileName: "README.md",
        detectedType: "project-overview",
        structuralScore: 0.4,
        missingSections: ["Architecture"],
        hasStubContent: true,
      }],
      feedback: {
        missing: ["Architecture overview"],
        suggestions: ["Ask your AI agent to read .adit/prompts/generate-docs.md and follow it to fill missing sections."],
        summaryPrompt: "Read .adit/prompts/generate-docs.md, fill the docs, then re-run link.",
      },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const result = await linkCommand(
        {} as never,
        client as never,
        "/workspace",
        "workspace-id",
        "https://cloud.example.com",
        {},
      );

      const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(output).toContain("[1/1] a ok | branches 1 | commits 1 | docs 1 | not qualified, score 0.41");
      expect(output).toContain("Quality feedback:");
      expect(output).toContain("Repository");
      expect(output).toContain("Quality");
      expect(output).toContain("Needs attention");
      expect(output).toContain("AI prompt");
      expect(output).toContain("a           0.41 needs docs");
      expect(output).toContain("1 docs below 60%; 1 placeholders; worst README.md…");
      expect(output).toContain("Fill docs for a");
      expect(output).toContain("AI prompt is not a shell command.");
      expect(output).toContain("Enter it in the AI agent opened at the workspace root.");
      expect(output).toContain("following .adit/prompts/generate-docs.md;");
      expect(output).toContain("generated docs stay in their existing locations.");
      expect(result.repositoryResults?.[0]?.qualityFeedback).toContain("Document scores:");
      expect(result.repositoryResults?.[0]?.summaryPrompt).toBe("Read .adit/prompts/generate-docs.md, fill the docs, then re-run link.");
      expect(result.repositoryResults?.[0]?.lowScoreDocumentCount).toBe(1);
      expect(result.repositoryResults?.[0]?.stubDocumentCount).toBe(1);
      expect(result.repositoryResults?.[0]?.missingItems).toEqual(["Architecture overview"]);
    } finally {
      log.mockRestore();
    }
  });

  it("passes project type and repository identity to project-link endpoints", async () => {
    const client = {
      post: vi.fn(async (path: string) => {
        if (path === "/api/project-link/negotiate") {
          return {
            confirmedProjectId: "server-project",
            projectName: "workspace-root",
            status: "confirmed",
          };
        }
        if (path === "/api/project-link/init") {
          return {
            projectLink: {
              branchCount: 1,
            },
          };
        }
        if (path === "/api/project-link/commits") {
          return {
            accepted: 0,
            totalCommits: 0,
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      }),
      get: vi.fn(),
      delete: vi.fn(),
    };

    mockLoadConfig.mockReturnValue({ projectRoot: "/workspace" });
    mockResolveCloudProjectContext.mockResolvedValue({
      projectType: "workspace",
      localProjectId: "workspace-id",
      projectRoot: "/workspace",
      projectName: "workspace-root",
      remoteUrl: null,
      canonicalRepoKey: null,
      repositories: [
        {
          localRepositoryId: "repo-id",
          relativePath: "packages/core",
          displayName: "core",
          path: "/workspace/packages/core",
          repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
          canonicalRepoKey: "github:varve-ai/adit-core",
        },
        {
          localRepositoryId: "cloud-repo-id",
          relativePath: "packages/cloud",
          displayName: "cloud",
          path: "/workspace/packages/cloud",
          repositoryUrl: "git@github.com:VARVE-ai/adit-cloud.git",
          canonicalRepoKey: "github:varve-ai/adit-cloud",
        },
      ],
    });
    mockGetProjectLinkCache.mockReturnValue(null);
    mockCollectBranches.mockResolvedValue([{ name: "main", headSha: "abc", isDefault: true }]);
    mockCollectDefaultBranch.mockResolvedValue("main");
    mockCollectGitIdentity.mockResolvedValue({ authorName: null, authorEmail: null });
    mockCollectCommitLogs.mockResolvedValue([]);
    mockCollectCommitCount.mockResolvedValue(0);
    mockCollectCommitFileStats.mockResolvedValue(new Map());
    mockResolveCommitBranches.mockResolvedValue(undefined);
    mockCollectGitRefsFingerprint.mockResolvedValue(null);
    mockDiscoverDocuments.mockReturnValue([]);

    await linkCommand(
      {} as never,
      client as never,
      "/workspace",
      "workspace-id",
      "https://cloud.example.com",
      { skipDocs: true, skipQualify: true, json: true },
    );

    expect(client.post).toHaveBeenCalledWith(
      "/api/project-link/negotiate",
      expect.objectContaining({
        localProjectId: "workspace-id",
        projectType: "workspace",
        projectName: "workspace-root",
        localRepositoryId: "repo-id",
        relativePath: "packages/core",
        displayName: "core",
        remoteUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
        repositories: [
          expect.objectContaining({
            localRepositoryId: "repo-id",
            relativePath: "packages/core",
            repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
          }),
          expect.objectContaining({
            localRepositoryId: "cloud-repo-id",
            relativePath: "packages/cloud",
            repositoryUrl: "git@github.com:VARVE-ai/adit-cloud.git",
          }),
        ],
      }),
    );
    expect(client.post).toHaveBeenCalledWith(
      "/api/project-link/init",
      expect.objectContaining({
        localProjectId: "workspace-id",
        projectType: "workspace",
        localRepositoryId: "repo-id",
        relativePath: "packages/core",
        displayName: "core",
        repositories: [
          expect.objectContaining({
            localRepositoryId: "repo-id",
            relativePath: "packages/core",
          }),
          expect.objectContaining({
            localRepositoryId: "cloud-repo-id",
            relativePath: "packages/cloud",
          }),
        ],
      }),
    );
  });

  it("prefixes workspace document source paths with repository relative paths", async () => {
    const client = {
      post: vi.fn(async (path: string) => {
        if (path === "/api/project-link/negotiate") {
          return {
            confirmedProjectId: "server-project",
            projectName: "workspace-root",
            status: "confirmed",
          };
        }
        if (path === "/api/project-link/init") {
          return { projectLink: { branchCount: 1 } };
        }
        if (path === "/api/project-link/commits") {
          return { accepted: 0, totalCommits: 0 };
        }
        if (path === "/api/project-link/documents") {
          return {
            summary: {
              created: 1,
              updated: 0,
              unchanged: 0,
              total: 1,
            },
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      }),
      get: vi.fn(),
      delete: vi.fn(),
    };

    mockLoadConfig.mockReturnValue({ projectRoot: "/workspace" });
    mockResolveCloudProjectContext.mockResolvedValue({
      projectType: "workspace",
      localProjectId: "workspace-id",
      projectRoot: "/workspace",
      projectName: "workspace-root",
      remoteUrl: null,
      canonicalRepoKey: null,
      repositories: [{
        localRepositoryId: "repo-id",
        relativePath: "packages/core",
        displayName: "core",
        path: "/workspace/packages/core",
        repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      }],
    });
    mockGetProjectLinkCache.mockReturnValue(null);
    mockCollectBranches.mockResolvedValue([{ name: "main", headSha: "abc", isDefault: true }]);
    mockCollectDefaultBranch.mockResolvedValue("main");
    mockCollectGitIdentity.mockResolvedValue({ authorName: null, authorEmail: null });
    mockCollectCommitLogs.mockResolvedValue([]);
    mockCollectCommitCount.mockResolvedValue(0);
    mockCollectCommitFileStats.mockResolvedValue(new Map());
    mockResolveCommitBranches.mockResolvedValue(undefined);
    mockCollectGitRefsFingerprint.mockResolvedValue(null);
    mockDiscoverDocuments.mockReturnValue([{
      fileName: "README.md",
      sourcePath: "README.md",
      content: "# Project\n\n## Purpose\nUseful context.",
      contentHash: "hash-1",
      sizeBytes: 32,
      status: "new",
    }]);

    await linkCommand(
      {} as never,
      client as never,
      "/workspace",
      "workspace-id",
      "https://cloud.example.com",
      { skipQualify: true, json: true },
    );

    expect(client.post).toHaveBeenCalledWith(
      "/api/project-link/documents",
      expect.objectContaining({
        documents: [expect.objectContaining({
          fileName: "README.md",
          sourcePath: "packages/core/README.md",
        })],
      }),
    );
  });

  it("deduplicates workspace commit uploads by SHA across repositories with the same canonical repo key", async () => {
    const repositories = [
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        displayName: "a",
        path: "/workspace/a",
        repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      },
      {
        localRepositoryId: "repo-b",
        relativePath: "b",
        displayName: "b",
        path: "/workspace/b",
        repositoryUrl: "https://github.com/VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      },
    ];
    const { client, commitRequests } = setupWorkspaceLinkTest(repositories, {
      "/workspace/a": [makeCommit("sha-1"), makeCommit("sha-2")],
      "/workspace/b": [makeCommit("sha-1"), makeCommit("sha-2")],
    });

    await linkCommand(
      {} as never,
      client as never,
      "/workspace",
      "workspace-id",
      "https://cloud.example.com",
      { skipDocs: true, skipQualify: true, json: true },
    );

    expect(commitRequests).toEqual([
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        commits: [{ sha: "sha-1" }, { sha: "sha-2" }],
      },
    ]);
  });

  it("uploads only new commit SHAs for later repositories with the same canonical repo key", async () => {
    const repositories = [
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        displayName: "a",
        path: "/workspace/a",
        repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      },
      {
        localRepositoryId: "repo-b",
        relativePath: "b",
        displayName: "b",
        path: "/workspace/b",
        repositoryUrl: "https://github.com/VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      },
    ];
    const { client, commitRequests } = setupWorkspaceLinkTest(repositories, {
      "/workspace/a": [makeCommit("sha-1"), makeCommit("sha-2")],
      "/workspace/b": [makeCommit("sha-2"), makeCommit("sha-3")],
    });

    await linkCommand(
      {} as never,
      client as never,
      "/workspace",
      "workspace-id",
      "https://cloud.example.com",
      { skipDocs: true, skipQualify: true, json: true },
    );

    expect(commitRequests).toEqual([
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        commits: [{ sha: "sha-1" }, { sha: "sha-2" }],
      },
      {
        localRepositoryId: "repo-b",
        relativePath: "b",
        commits: [{ sha: "sha-3" }],
      },
    ]);
  });

  it("deduplicates workspace commit uploads by SHA across different canonical repo keys", async () => {
    const repositories = [
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        displayName: "a",
        path: "/workspace/a",
        repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      },
      {
        localRepositoryId: "repo-b",
        relativePath: "b",
        displayName: "b",
        path: "/workspace/b",
        repositoryUrl: "git@github.com:VARVE-ai/adit-cloud.git",
        canonicalRepoKey: "github:varve-ai/adit-cloud",
      },
    ];
    const { client, commitRequests } = setupWorkspaceLinkTest(repositories, {
      "/workspace/a": [makeCommit("sha-1")],
      "/workspace/b": [makeCommit("sha-1")],
    });

    await linkCommand(
      {} as never,
      client as never,
      "/workspace",
      "workspace-id",
      "https://cloud.example.com",
      { skipDocs: true, skipQualify: true, json: true },
    );

    expect(commitRequests).toEqual([
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        commits: [{ sha: "sha-1" }],
      },
    ]);
  });

  it("uploads only unseen SHAs for forked workspace repositories", async () => {
    const repositories = [
      {
        localRepositoryId: "repo-upstream",
        relativePath: "upstream",
        displayName: "upstream",
        path: "/workspace/upstream",
        repositoryUrl: "git@github.com:VARVE-ai/adit-core.git",
        canonicalRepoKey: "github:varve-ai/adit-core",
      },
      {
        localRepositoryId: "repo-fork",
        relativePath: "fork",
        displayName: "fork",
        path: "/workspace/fork",
        repositoryUrl: "git@github.com:edy/adit-core.git",
        canonicalRepoKey: "github:edy/adit-core",
      },
    ];
    const { client, commitRequests } = setupWorkspaceLinkTest(repositories, {
      "/workspace/upstream": [makeCommit("shared-2"), makeCommit("shared-1")],
      "/workspace/fork": [makeCommit("fork-only"), makeCommit("shared-2"), makeCommit("shared-1")],
    });

    await linkCommand(
      {} as never,
      client as never,
      "/workspace",
      "workspace-id",
      "https://cloud.example.com",
      { skipDocs: true, skipQualify: true, json: true },
    );

    expect(commitRequests).toEqual([
      {
        localRepositoryId: "repo-upstream",
        relativePath: "upstream",
        commits: [{ sha: "shared-2" }, { sha: "shared-1" }],
      },
      {
        localRepositoryId: "repo-fork",
        relativePath: "fork",
        commits: [{ sha: "fork-only" }],
      },
    ]);
  });

  it("deduplicates workspace commit uploads by SHA when canonical repo key is unavailable", async () => {
    const repositories = [
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        displayName: "a",
        path: "/workspace/a",
        repositoryUrl: "ssh://example.com/repos/adit-core.git",
        canonicalRepoKey: null,
      },
      {
        localRepositoryId: "repo-b",
        relativePath: "b",
        displayName: "b",
        path: "/workspace/b",
        repositoryUrl: "ssh://example.com/repos/adit-core.git",
        canonicalRepoKey: null,
      },
    ];
    const { client, commitRequests } = setupWorkspaceLinkTest(repositories, {
      "/workspace/a": [makeCommit("sha-1")],
      "/workspace/b": [makeCommit("sha-1")],
    });

    await linkCommand(
      {} as never,
      client as never,
      "/workspace",
      "workspace-id",
      "https://cloud.example.com",
      { skipDocs: true, skipQualify: true, json: true },
    );

    expect(commitRequests).toEqual([
      {
        localRepositoryId: "repo-a",
        relativePath: "a",
        commits: [{ sha: "sha-1" }],
      },
    ]);
  });
});
