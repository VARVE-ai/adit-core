import { beforeEach, describe, expect, it, vi } from "vitest";

const getCache = vi.fn();
const updateGitState = vi.fn();
const collectFingerprint = vi.fn();
const collectBranches = vi.fn();
const collectDefaultBranch = vi.fn();
const collectIdentity = vi.fn();
const collectCommits = vi.fn();
const resolveBranches = vi.fn();
const collectFileStats = vi.fn();

vi.mock("./cache.js", () => ({
  getProjectLinkCache: (...args: unknown[]) => getCache(...args),
  updateCachedGitState: (...args: unknown[]) => updateGitState(...args),
}));

vi.mock("./git-collector.js", () => ({
  collectGitRefsFingerprint: (...args: unknown[]) => collectFingerprint(...args),
  collectBranches: (...args: unknown[]) => collectBranches(...args),
  branchHeadMap: (branches: Array<{ name: string; headSha: string }>) =>
    Object.fromEntries(branches.map((branch) => [branch.name, branch.headSha])),
  collectDefaultBranch: (...args: unknown[]) => collectDefaultBranch(...args),
  collectGitIdentity: (...args: unknown[]) => collectIdentity(...args),
  collectCommitsBetweenRefSnapshots: (...args: unknown[]) => collectCommits(...args),
  resolveCommitBranches: (...args: unknown[]) => resolveBranches(...args),
  collectCommitFileStats: (...args: unknown[]) => collectFileStats(...args),
}));

vi.mock("../project-context.js", () => ({
  repositoryPayloads: (repositories: unknown[]) => repositories,
}));

import { syncLinkedGitMetadata } from "./git-sync.js";

const repository = {
  localRepositoryId: "repo-1",
  relativePath: ".",
  displayName: "repo",
  path: "/repo",
  repositoryUrl: "git@github.com:owner/repo.git",
  canonicalRepoKey: "github:owner/repo",
};

const context = {
  projectType: "repo" as const,
  localProjectId: "project-1",
  projectRoot: "/repo",
  projectName: "repo",
  repositories: [repository],
  remoteUrl: repository.repositoryUrl,
  canonicalRepoKey: repository.canonicalRepoKey,
};

function linkedCache() {
  return {
    projectId: "project-1",
    repositoryId: "repo-1",
    serverUrl: "https://cloud.example.com",
    confirmedProjectId: "cloud-project-1",
    gitRefHeads: { main: "old-sha" },
    gitRefsFingerprint: "old-fingerprint",
    lastBranchSyncAt: "2026-01-01T00:00:00.000Z",
    lastDocSyncAt: null,
    docHashes: {},
    qualified: true,
    initializedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("syncLinkedGitMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCache.mockReturnValue(linkedCache());
    collectFingerprint.mockResolvedValue("new-fingerprint");
    collectBranches.mockResolvedValue([{ name: "main", headSha: "new-sha", isDefault: true }]);
    collectDefaultBranch.mockResolvedValue("main");
    collectIdentity.mockResolvedValue({ authorName: "A", authorEmail: "a@example.com" });
    collectCommits.mockResolvedValue([{
      sha: "new-sha",
      parentSha: "old-sha",
      authorName: "A",
      authorEmail: "a@example.com",
      date: "2026-01-02T00:00:00.000Z",
      message: "New commit",
      branch: "main",
    }]);
    resolveBranches.mockResolvedValue(undefined);
    collectFileStats.mockResolvedValue(new Map());
  });

  it("skips repositories that have never been linked", async () => {
    getCache.mockReturnValue(null);
    const client = { post: vi.fn() };

    const result = await syncLinkedGitMetadata(
      {} as never,
      client as never,
      context,
      "https://cloud.example.com",
    );

    expect(result.repositoriesSkipped).toBe(1);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("uploads changed branches and only newly reachable commits before advancing the cursor", async () => {
    const client = {
      post: vi.fn(async (path: string) => path.endsWith("/commits")
        ? { accepted: 1, totalCommits: 2, latestCommitSha: "new-sha", duplicates: 0 }
        : { projectLink: { branchCount: 1 } }),
    };

    const result = await syncLinkedGitMetadata(
      {} as never,
      client as never,
      context,
      "https://cloud.example.com",
    );

    expect(collectCommits).toHaveBeenCalledWith(
      "/repo",
      { main: "new-sha" },
      { main: "old-sha" },
    );
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/api/project-link/init",
      expect.objectContaining({ branches: [{ name: "main", headSha: "new-sha" }] }),
    );
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      "/api/project-link/commits",
      expect.objectContaining({ commits: [expect.objectContaining({ sha: "new-sha" })] }),
    );
    expect(updateGitState).toHaveBeenCalledWith(
      expect.anything(),
      "project-1",
      "https://cloud.example.com",
      {
        refHeads: { main: "new-sha" },
        refsFingerprint: "new-fingerprint",
      },
      "repo-1",
    );
    expect(result.commitsUploaded).toBe(1);
  });

  it("does not advance the cursor when a Git upload fails", async () => {
    const client = {
      post: vi.fn(async (path: string) => {
        if (path.endsWith("/commits")) throw new Error("upload failed");
        return { projectLink: { branchCount: 1 } };
      }),
    };

    const result = await syncLinkedGitMetadata(
      {} as never,
      client as never,
      context,
      "https://cloud.example.com",
    );

    expect(updateGitState).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      expect.objectContaining({ relativePath: ".", message: "upload failed" }),
    ]);
  });
});
