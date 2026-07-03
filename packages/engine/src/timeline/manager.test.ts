/**
 * Tests for the timeline manager.
 *
 * Verifies:
 * - recordEvent uses insertEventAutoSeq (not allocateSequence + insertEvent)
 * - recordEvent throws explicit error if post-insert re-fetch returns null
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockInsertEventAutoSeq = vi.fn();
const mockGetEventById = vi.fn();

vi.mock("@varveai/adit-core", () => ({
  generateId: vi.fn(() => "evt-new-001"),
  createClock: vi.fn(() => ({ "test-client": 1 })),
  serialize: vi.fn(() => '{"test-client":1}'),
  insertEventAutoSeq: (...args: unknown[]) => mockInsertEventAutoSeq(...args),
  getEventById: (...args: unknown[]) => mockGetEventById(...args),
  queryEvents: vi.fn(() => []),
  searchEvents: vi.fn(() => []),
  getDiffText: vi.fn(() => null),
}));

vi.mock("../git/runner.js", () => ({
  getHeadSha: vi.fn().mockResolvedValue("head-sha-123"),
  getCurrentBranch: vi.fn().mockResolvedValue("main"),
}));

import { createTimelineManager } from "./manager.js";
import type { AditConfig } from "@varveai/adit-core";
import { getCurrentBranch, getHeadSha } from "../git/runner.js";

const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockGetHeadSha = vi.mocked(getHeadSha);

const fakeDb = {} as never;
const fakeConfig: AditConfig = {
  projectRoot: "/test-project",
  dataDir: "/tmp/adit-test",
  dbPath: "/tmp/test.db",
  projectId: "proj-001",
  projectType: "repo",
  repositories: [{
    localRepositoryId: "proj-001",
    relativePath: ".",
    displayName: "test-project",
    repositoryUrl: null,
    canonicalRepoKey: null,
    path: "/test-project",
  }],
  clientId: "test-client",
  captureEnv: false,
};

describe("TimelineManager.recordEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses insertEventAutoSeq (not allocateSequence + insertEvent)", async () => {
    mockGetEventById.mockReturnValue({
      id: "evt-new-001",
      sessionId: "sess-001",
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
    });

    const tm = createTimelineManager(fakeDb, fakeConfig);
    await tm.recordEvent({
      sessionId: "sess-001",
      eventType: "prompt_submit",
      actor: "user",
      promptText: "Hello",
    });

    expect(mockInsertEventAutoSeq).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        id: "evt-new-001",
        sessionId: "sess-001",
        eventType: "prompt_submit",
        actor: "user",
        promptText: "Hello",
      }),
    );
    // Verify no 'sequence' field is passed (it's computed in the SQL)
    const insertArg = mockInsertEventAutoSeq.mock.calls[0][1];
    expect(insertArg).not.toHaveProperty("sequence");
  });

  it("throws explicit error when getEventById returns null after insert", async () => {
    mockGetEventById.mockReturnValue(null);

    const tm = createTimelineManager(fakeDb, fakeConfig);

    await expect(
      tm.recordEvent({
        sessionId: "sess-001",
        eventType: "prompt_submit",
        actor: "user",
      }),
    ).rejects.toThrow("Failed to retrieve event after insert: evt-new-001");
  });

  it("uses explicit git branch and head overrides, including null", async () => {
    mockGetEventById.mockReturnValue({
      id: "evt-new-001",
      sessionId: "sess-001",
      sequence: 1,
      eventType: "assistant_response",
      actor: "assistant",
    });

    const tm = createTimelineManager(fakeDb, fakeConfig);
    await tm.recordEvent({
      sessionId: "sess-001",
      eventType: "assistant_response",
      actor: "assistant",
      gitBranch: null,
      gitHeadSha: "workspace-sha",
    });

    expect(mockGetCurrentBranch).not.toHaveBeenCalled();
    expect(mockGetHeadSha).not.toHaveBeenCalled();
    expect(mockInsertEventAutoSeq).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        gitBranch: null,
        gitHeadSha: "workspace-sha",
      }),
    );
  });

});
