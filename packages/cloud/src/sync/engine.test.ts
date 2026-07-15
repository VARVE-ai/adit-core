/**
 * Tests for the SyncEngine.
 *
 * Verifies cursor-based incremental push, batch termination conditions,
 * and the infinite-loop guard (all duplicates + unchanged cursor).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@varveai/adit-core", () => ({
  applyAuthoritativeSyncState: vi.fn(),
  getSyncState: vi.fn(() => null),
  upsertSyncState: vi.fn(),
  withPerf: vi.fn((_dir: string, _cat: string, _op: string, fn: () => unknown) => fn()),
}));

vi.mock("./serializer.js", () => ({
  buildSyncBatch: vi.fn(),
  batchRecordCount: vi.fn(),
  countUnsyncedRecords: vi.fn(() => 0),
}));

vi.mock("./conflicts.js", () => ({
  handleConflicts: vi.fn(),
}));

import { SyncEngine } from "./engine.js";
import {
  applyAuthoritativeSyncState,
  upsertSyncState,
} from "@varveai/adit-core";
import { buildSyncBatch, batchRecordCount, countUnsyncedRecords } from "./serializer.js";

const mockBuildSyncBatch = vi.mocked(buildSyncBatch);
const mockBatchRecordCount = vi.mocked(batchRecordCount);
const mockCountUnsyncedRecords = vi.mocked(countUnsyncedRecords);
const mockApplyAuthoritativeSyncState = vi.mocked(applyAuthoritativeSyncState);
const mockUpsertSyncState = vi.mocked(upsertSyncState);

function createEngine(
  overrides: {
    batchSize?: number;
    projectId?: string;
    projectName?: string;
    remoteUrl?: string | null;
    canonicalRepoKey?: string | null;
  } = {},
) {
  const projectId = overrides.projectId ?? "proj-001";
  const mockClient = {
    get: vi.fn().mockResolvedValue({
      lastSyncedEventId: null,
      syncVersion: 0,
      lastSyncedAt: null,
      projectCursors: {
        [projectId]: {
          lastSyncedEventId: null,
          lastSyncedAt: null,
        },
      },
    }),
    post: vi.fn().mockResolvedValue({
      accepted: 0,
      duplicates: 0,
      conflicts: [],
      newSyncCursor: "cursor-1",
      newSyncVersion: 1,
      projectCursor: {
        lastSyncedEventId: "cursor-1",
        lastSyncedAt: "2025-01-01T00:00:00Z",
      },
    }),
  };

  const engine = new SyncEngine({} as never, mockClient as never, {
    projectId,
    projectName: overrides.projectName,
    remoteUrl: overrides.remoteUrl,
    canonicalRepoKey: overrides.canonicalRepoKey,
    batchSize: overrides.batchSize ?? 500,
    serverUrl: "https://cloud.example.com",
    cloudClientId: "client-001",
  });

  return { engine, mockClient };
}

describe("SyncEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when no records to sync", async () => {
    const { engine, mockClient } = createEngine();
    mockBatchRecordCount.mockReturnValue(0);
    mockBuildSyncBatch.mockReturnValue({ batch: { events: [], sessions: [], envSnapshots: [] }, diffByteCapApplied: false } as never);

    const result = await engine.sync();

    expect(result.batches).toBe(0);
    expect(result.totalRecords).toBe(0);
    expect(result.accepted).toBe(0);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it("pushes a single batch and stops when count < batchSize", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 500 });
    mockBuildSyncBatch.mockImplementation(() => ({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false }) as never);
    let callCount = 0;
    mockBatchRecordCount.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? 10 : 0;
    });
    mockClient.post.mockResolvedValue({
      accepted: 10,
      duplicates: 0,
      conflicts: [],
      newSyncCursor: "cursor-after-10",
      newSyncVersion: 1,
      projectCursor: {
        lastSyncedEventId: "cursor-after-10",
        lastSyncedAt: "2025-01-01T00:00:00Z",
      },
    });

    const result = await engine.sync();

    expect(result.batches).toBe(1);
    expect(result.totalRecords).toBe(10);
    expect(result.accepted).toBe(10);
    expect(mockApplyAuthoritativeSyncState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lastSyncedEventId: "cursor-after-10",
      }),
    );
  });

  it("pushes multiple batches when first batch is full", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 100 });

    mockBuildSyncBatch.mockImplementation(() => ({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false }) as never);
    let callCount = 0;
    mockBatchRecordCount.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? 100 : 50;
    });

    mockClient.post
      .mockResolvedValueOnce({
        accepted: 100,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: "cursor-100",
        newSyncVersion: 1,
        projectCursor: {
          lastSyncedEventId: "cursor-100",
          lastSyncedAt: "2025-01-01T00:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        accepted: 50,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: "cursor-150",
        newSyncVersion: 2,
        projectCursor: {
          lastSyncedEventId: "cursor-150",
          lastSyncedAt: "2025-01-01T00:00:00Z",
        },
      });

    const result = await engine.sync();

    expect(result.batches).toBe(2);
    expect(result.totalRecords).toBe(150);
    expect(result.accepted).toBe(150);
  });

  it("breaks on duplicate-only batch with unchanged cursor (infinite loop guard)", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 100 });
    mockBuildSyncBatch.mockReturnValue({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false } as never);
    mockBatchRecordCount.mockReturnValue(100); // always full

    // Server returns all duplicates and doesn't advance cursor
    mockClient.post.mockResolvedValue({
      accepted: 0,
      duplicates: 100,
      conflicts: [],
      newSyncCursor: null, // cursor unchanged (was null, still null)
      newSyncVersion: 0,
      projectCursor: {
        lastSyncedEventId: null,
        lastSyncedAt: null,
      },
    });

    const result = await engine.sync();

    // Should have stopped after 1 batch instead of looping forever
    expect(result.batches).toBe(1);
    expect(result.accepted).toBe(0);
    expect(result.duplicates).toBe(100);
  });

  it("continues when cursor advances even with all duplicates", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 100 });
    mockBuildSyncBatch.mockReturnValue({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false } as never);
    mockBatchRecordCount
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(0); // stops on second call

    // Server returns all duplicates but advances cursor
    mockClient.post.mockResolvedValueOnce({
      accepted: 0,
      duplicates: 100,
      conflicts: [],
      newSyncCursor: "cursor-advanced",
      newSyncVersion: 1,
      projectCursor: {
        lastSyncedEventId: "cursor-advanced",
        lastSyncedAt: "2025-01-01T00:00:00Z",
      },
    });

    const result = await engine.sync();

    // Should have continued past the first batch since cursor advanced
    expect(result.batches).toBe(1);
  });

  it("accumulates conflicts across batches", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 100 });

    let batchCall = 0;
    mockBuildSyncBatch.mockImplementation(() => ({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false }) as never);
    mockBatchRecordCount.mockImplementation(() => {
      batchCall++;
      if (batchCall === 1) return 100;
      return 50;
    });

    mockClient.post
      .mockResolvedValueOnce({
        accepted: 99,
        duplicates: 0,
        conflicts: [{ type: "event", id: "evt-001", resolution: "server_wins" }],
        newSyncCursor: "cursor-100",
        newSyncVersion: 1,
        projectCursor: {
          lastSyncedEventId: "cursor-100",
          lastSyncedAt: "2025-01-01T00:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        accepted: 49,
        duplicates: 0,
        conflicts: [{ type: "session", id: "sess-001", resolution: "server_wins" }],
        newSyncCursor: "cursor-150",
        newSyncVersion: 2,
        projectCursor: {
          lastSyncedEventId: "cursor-150",
          lastSyncedAt: "2025-01-01T00:00:00Z",
        },
      });

    const result = await engine.sync();

    expect(result.conflicts).toHaveLength(2);
    expect(result.accepted).toBe(148);
  });

  it("includes repository identity in sync push payload", async () => {
    const { engine, mockClient } = createEngine({
      remoteUrl: "git@github.com:VARVE-ai/adit-cloud.git",
      canonicalRepoKey: "github:varve-ai/adit-cloud",
    });
    mockBuildSyncBatch.mockReturnValue({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false } as never);
    mockBatchRecordCount.mockReturnValue(1);
    mockClient.post.mockResolvedValue({
      accepted: 1,
      duplicates: 0,
      conflicts: [],
      newSyncCursor: "cursor-1",
      newSyncVersion: 1,
      projectCursor: {
        lastSyncedEventId: "cursor-1",
        lastSyncedAt: "2025-01-01T00:00:00Z",
      },
    });

    await engine.sync();

    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/sync/push",
      expect.objectContaining({
        projectType: "repo",
        remoteUrl: "git@github.com:VARVE-ai/adit-cloud.git",
        canonicalRepoKey: "github:varve-ai/adit-cloud",
        repositories: [expect.objectContaining({
          localRepositoryId: "proj-001",
          relativePath: ".",
          repositoryUrl: "git@github.com:VARVE-ai/adit-cloud.git",
          canonicalRepoKey: "github:varve-ai/adit-cloud",
        })],
      }),
    );
  });

  it("includes workspace repository list in sync push payload", async () => {
    const { mockClient } = createEngine();
    const workspaceEngine = new SyncEngine({} as never, mockClient as never, {
      projectId: "workspace-001",
      projectName: "workspace",
      projectType: "workspace",
      repositories: [
        {
          localRepositoryId: "repo-api",
          relativePath: "api",
          displayName: "api",
          repositoryUrl: "git@github.com:VARVE-ai/api.git",
          canonicalRepoKey: "github:varve-ai/api",
        },
        {
          localRepositoryId: "repo-web",
          relativePath: "web",
          displayName: "web",
          repositoryUrl: "git@github.com:VARVE-ai/web.git",
          canonicalRepoKey: "github:varve-ai/web",
        },
      ],
      batchSize: 500,
      serverUrl: "https://cloud.example.com",
      cloudClientId: "client-001",
    });
    mockBuildSyncBatch.mockReturnValue({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false } as never);
    mockBatchRecordCount.mockReturnValue(1);
    mockClient.post.mockResolvedValue({
      accepted: 1,
      duplicates: 0,
      conflicts: [],
      newSyncCursor: "cursor-1",
      newSyncVersion: 1,
      projectCursor: {
        lastSyncedEventId: "cursor-1",
        lastSyncedAt: "2025-01-01T00:00:00Z",
      },
    });

    await workspaceEngine.sync();

    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/sync/push",
      expect.objectContaining({
        localProjectId: "workspace-001",
        projectType: "workspace",
        repositories: [
          expect.objectContaining({ localRepositoryId: "repo-api", relativePath: "api" }),
          expect.objectContaining({ localRepositoryId: "repo-web", relativePath: "web" }),
        ],
      }),
    );
  });

  describe("per-project cursors", () => {
    it("uses per-project cursor from projectCursors map", async () => {
      const { engine, mockClient } = createEngine({ batchSize: 500 });
      mockClient.get.mockResolvedValue({
        lastSyncedEventId: "global-cursor-999",
        syncVersion: 5,
        lastSyncedAt: "2025-01-01T00:00:00Z",
        projectCursors: {
          "proj-001": {
            lastSyncedEventId: "project-cursor-42",
            lastSyncedAt: "2025-01-02T00:00:00Z",
          },
        },
      });

      mockBuildSyncBatch.mockReturnValue({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false } as never);
      let callCount = 0;
      mockBatchRecordCount.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 5 : 0;
      });
      mockClient.post.mockResolvedValue({
        accepted: 5,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: "project-cursor-47",
        newSyncVersion: 6,
        projectCursor: {
          lastSyncedEventId: "project-cursor-47",
          lastSyncedAt: "2025-01-02T00:05:00Z",
        },
      });

      const result = await engine.sync();

      expect(result.batches).toBe(1);
      expect(result.accepted).toBe(5);
      // buildSyncBatch should have been called with the per-project cursor,
      // not the global one
      expect(mockBuildSyncBatch).toHaveBeenCalledWith(
        expect.anything(),
        "project-cursor-42",
        "2025-01-02T00:00:00Z",
        "proj-001",
        "client-001",
        500,
      );
      expect(mockApplyAuthoritativeSyncState).toHaveBeenCalled();
      expect(mockUpsertSyncState).not.toHaveBeenCalled();
    });

    it("does full push when projectCursors exists but project has no entry", async () => {
      const { engine, mockClient } = createEngine({
        batchSize: 500,
        projectName: "new-project",
      });
      mockClient.get.mockResolvedValue({
        lastSyncedEventId: "global-cursor-999",
        syncVersion: 5,
        lastSyncedAt: "2025-01-01T00:00:00Z",
        projectCursors: {
          "other-project": {
            lastSyncedEventId: "other-cursor-10",
            lastSyncedAt: "2025-01-01T00:00:00Z",
          },
        },
      });

      mockBuildSyncBatch.mockReturnValue({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false } as never);
      let callCount = 0;
      mockBatchRecordCount.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 3 : 0;
      });
      mockClient.post.mockResolvedValue({
        accepted: 3,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: "new-cursor",
        newSyncVersion: 6,
        projectCursor: {
          lastSyncedEventId: "new-cursor",
          lastSyncedAt: "2025-01-02T00:05:00Z",
        },
      });

      const result = await engine.sync();

      expect(result.batches).toBe(1);
      // Should have started with null cursor (full push)
      expect(mockBuildSyncBatch).toHaveBeenCalledWith(
        expect.anything(),
        null,
        null,
        "proj-001",
        "client-001",
        500,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        "/api/sync/push",
        expect.objectContaining({
          localProjectId: "proj-001",
          projectName: "new-project",
        }),
      );
    });

    it("does not send projectName for an existing project", async () => {
      const { engine, mockClient } = createEngine({
        batchSize: 500,
        projectName: "local-name",
      });
      mockClient.get.mockResolvedValue({
        lastSyncedEventId: "global-cursor-999",
        syncVersion: 5,
        lastSyncedAt: "2025-01-01T00:00:00Z",
        projectCursor: {
          localProjectId: "proj-001",
          serverProjectId: "server-project-001",
          lastSyncedEventId: null,
          lastSyncedAt: null,
        },
      });

      mockBuildSyncBatch.mockReturnValue({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false } as never);
      mockBatchRecordCount.mockReturnValue(1);
      mockClient.post.mockResolvedValue({
        accepted: 1,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: "new-cursor",
        newSyncVersion: 6,
        projectCursor: {
          lastSyncedEventId: "new-cursor",
          lastSyncedAt: "2025-01-02T00:05:00Z",
        },
      });

      await engine.sync();

      expect(mockClient.post).toHaveBeenCalledWith(
        "/api/sync/push",
        expect.not.objectContaining({
          projectName: expect.any(String),
        }),
      );
    });

    it("falls back to global cursor on legacy server without projectCursors", async () => {
      const { engine, mockClient } = createEngine({ batchSize: 500 });
      // Legacy server response — no projectCursors field
      mockClient.get.mockResolvedValue({
        lastSyncedEventId: "legacy-global-cursor",
        syncVersion: 3,
        lastSyncedAt: "2025-01-01T00:00:00Z",
      });

      mockBuildSyncBatch.mockReturnValue({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false } as never);
      let callCount = 0;
      mockBatchRecordCount.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 2 : 0;
      });
      mockClient.post.mockResolvedValue({
        accepted: 2,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: "legacy-cursor-2",
        newSyncVersion: 4,
      });

      const result = await engine.sync();

      expect(result.batches).toBe(1);
      // Should use the global cursor as fallback
      expect(mockBuildSyncBatch).toHaveBeenCalledWith(
        expect.anything(),
        "legacy-global-cursor",
        "2025-01-01T00:00:00Z",
        "proj-001",
        "client-001",
        500,
      );
      expect(mockUpsertSyncState).toHaveBeenCalled();
      expect(mockApplyAuthoritativeSyncState).not.toHaveBeenCalled();
    });

    it("persists the project cursor instead of the global push cursor", async () => {
      const { engine, mockClient } = createEngine({ batchSize: 500 });
      mockClient.get.mockResolvedValue({
        lastSyncedEventId: "evt-debug-1783148414696-6",
        syncVersion: 2167,
        lastSyncedAt: "2026-07-13T08:52:27.222Z",
        projectCursor: {
          localProjectId: "proj-001",
          serverProjectId: "server-project-001",
          lastSyncedEventId: "01KXDAPNWZJZN7YWFZ3CWCGF35",
          lastSyncedAt: "2026-07-13T08:52:27.222Z",
        },
      });
      mockBuildSyncBatch.mockReturnValue({ batch: { events: [{}], sessions: [] }, diffByteCapApplied: false } as never);
      mockBatchRecordCount.mockReturnValue(3);
      mockClient.post.mockResolvedValue({
        accepted: 3,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: "evt-debug-1783148414696-6",
        newSyncVersion: 2168,
        projectCursor: {
          lastSyncedEventId: "01KXDAX3F9ZNGCF1F80QX0JYQE",
          lastSyncedAt: "2026-07-13T08:56:04.752Z",
        },
      });

      const result = await engine.sync();

      expect(result.newSyncCursor).toBe("01KXDAX3F9ZNGCF1F80QX0JYQE");
      expect(mockApplyAuthoritativeSyncState).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          lastSyncedEventId: "01KXDAX3F9ZNGCF1F80QX0JYQE",
          syncVersion: 2168,
        }),
      );
    });

    it("passes localProjectId as query param to getRemoteStatus", async () => {
      const { engine, mockClient } = createEngine();
      mockBatchRecordCount.mockReturnValue(0);
      mockBuildSyncBatch.mockReturnValue({ batch: { events: [], sessions: [] }, diffByteCapApplied: false } as never);

      await engine.sync();

      expect(mockClient.get).toHaveBeenCalledWith(
        expect.stringContaining("localProjectId=proj-001"),
      );
    });
  });
});
