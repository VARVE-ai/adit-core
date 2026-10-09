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
  it("reports runtime even with no conversation batches, after normal sync", async () => {
    const steps: string[] = [];
    engineSync.mockImplementation(async () => { steps.push("business"); return { batches: 0, accepted: 0 }; });
    const report = { schemaVersion: 1, source: "cli", version: "1.2.0", checkedAt: new Date().toISOString(), projectId: "p", components: [], platforms: [], checks: [] };
    const post = vi.fn(async () => { steps.push("report"); return { upgrade: { state: "current" } }; });
    const result = await runSyncCycle({ db: {} as never, client: {} as never, projectContext, batchSize: 500,
      serverUrl: "https://cloud.example.com", cloudClientId: "client-1", runtimeClient: { post } as never,
      collectRuntimeReport: async () => { steps.push("diagnostics"); return report as never; } });
    expect(steps).toEqual(["business", "diagnostics", "report"]);
    expect(post).toHaveBeenCalledWith("/api/sync/runtime", report);
    expect(result.upgrade?.state).toBe("current");
  });

  it.each(["collect", "upload"])("preserves successful business sync when runtime %s fails", async (failure) => {
    engineSync.mockResolvedValue({ batches: 0, accepted: 7 });
    const post = vi.fn(async () => { throw new Error("offline"); });
    const result = await runSyncCycle({ db: {} as never, client: {} as never, projectContext, batchSize: 500,
      serverUrl: "https://cloud.example.com", cloudClientId: "client-1", runtimeClient: { post } as never,
      collectRuntimeReport: async () => { if (failure === "collect") throw new Error("diagnostics"); return {} as never; } });
    expect(result.accepted).toBe(7);
    expect(result.runtimeReportError).toBeTruthy();
    if (failure === "collect") expect(post).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends an empty saved selection even when there are no event batches or repositories", async () => {
    engineSync.mockResolvedValue({ accepted: 0, duplicates: 0, conflicts: [], newSyncCursor: null, batches: 0, totalRecords: 0 });
    const post = vi.fn(async () => ({ status: "updated" }));
    const registration = { localProjectId: "project-1", projectName: "repo", updatedAt: "2026-09-09T01:00:00.000Z", repositories: [] };
    await runSyncCycle({ db: {} as never, client: { post } as never,
      projectContext: { ...projectContext, registration }, batchSize: 500,
      serverUrl: "https://cloud.example.com", cloudClientId: "client-1" });
    expect(post).toHaveBeenCalledWith("/api/project-link/registration", registration);
    expect(engineSync).toHaveBeenCalledOnce();
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

  it("checks Git during a manual sync even when conversation data is current", async () => {
    engineSync.mockResolvedValue({
      accepted: 0,
      duplicates: 0,
      conflicts: [],
      newSyncCursor: null,
      batches: 0,
      totalRecords: 0,
    });
    gitSync.mockResolvedValue({
      repositoriesChecked: 1,
      repositoriesUpdated: 0,
      repositoriesSkipped: 1,
      branchesUploaded: 0,
      commitsUploaded: 0,
      skips: [{
        repositoryId: "repo-1",
        relativePath: ".",
        reason: "unchanged",
        message: "Local Git refs have not changed",
      }],
      failures: [],
      warnings: [],
    });

    const result = await runSyncCycle({
      db: {} as never,
      client: {} as never,
      projectContext,
      batchSize: 500,
      serverUrl: "https://cloud.example.com/",
      cloudClientId: "client-1",
      syncGitWhenNoBatches: true,
    });

    expect(gitSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      projectContext,
      "https://cloud.example.com",
      { forceRemoteBranchCheck: undefined },
    );
    expect(result.git?.repositoriesSkipped).toBe(1);
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
      skips: [],
      failures: [],
      warnings: [],
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
