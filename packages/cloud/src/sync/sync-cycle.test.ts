import { beforeEach, describe, expect, it, vi } from "vitest";

const engineSync = vi.fn();
const gitSync = vi.fn();

vi.mock("./engine.js", () => ({
  SyncEngine: class MockSyncEngine {
    sync = engineSync;
  },
}));

vi.mock("../project-link/git-sync.js", () => ({
  syncLinkedGitMetadata: (...args: unknown[]) => gitSync(...args),
}));

vi.mock("../project-context.js", () => ({
  repositoryPayloads: (repositories: unknown[]) => repositories,
}));

import { runSyncCycle } from "./sync-cycle.js";

const projectContext = {
  projectType: "repo" as const,
  localProjectId: "project-1",
  projectRoot: "/repo",
  projectName: "repo",
  repositories: [],
  remoteUrl: null,
  canonicalRepoKey: null,
};

describe("runSyncCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not inspect Git when no Event batch was uploaded", async () => {
    engineSync.mockResolvedValue({
      accepted: 0,
      duplicates: 0,
      conflicts: [],
      newSyncCursor: null,
      batches: 0,
      totalRecords: 0,
    });

    const result = await runSyncCycle({
      db: {} as never,
      client: {} as never,
      projectContext,
      batchSize: 500,
      serverUrl: "https://cloud.example.com",
      cloudClientId: "client-1",
    });

    expect(result.git).toBeNull();
    expect(gitSync).not.toHaveBeenCalled();
  });

  it("checks Git after the Event batch succeeds", async () => {
    engineSync.mockResolvedValue({
      accepted: 3,
      duplicates: 0,
      conflicts: [],
      newSyncCursor: "event-2",
      batches: 1,
      totalRecords: 3,
    });
    gitSync.mockResolvedValue({
      repositoriesChecked: 1,
      repositoriesUpdated: 1,
      repositoriesSkipped: 0,
      branchesUploaded: 1,
      commitsUploaded: 1,
      failures: [],
    });

    const result = await runSyncCycle({
      db: {} as never,
      client: {} as never,
      projectContext,
      batchSize: 500,
      serverUrl: "https://cloud.example.com",
      cloudClientId: "client-1",
    });

    expect(gitSync).toHaveBeenCalledTimes(1);
    expect(result.git?.commitsUploaded).toBe(1);
  });
});
