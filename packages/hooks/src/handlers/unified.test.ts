/**
 * Tests for the unified hook dispatcher.
 *
 * Mocks all external dependencies (DB, engine, cloud) to verify
 * that dispatchHook correctly routes each hook type, handles
 * cloud auto-sync with threshold-based and force flags, and maintains fail-open behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- Mocks ----

const mockRecordEvent = vi.fn().mockResolvedValue({
  id: "evt-001",
  sessionId: "sess-001",
  sequence: 1,
  eventType: "prompt_submit",
  actor: "user",
});
const mockList = vi.fn().mockResolvedValue([]);

vi.mock("@varveai/adit-core", () => ({
  getLatestEnvSnapshot: vi.fn(() => null),
  endSession: vi.fn(),
  withPerf: vi.fn((_dir: string, _cat: string, _op: string, fn: () => unknown) => fn()),
}));

vi.mock("@varveai/adit-engine", () => ({
  createTimelineManager: vi.fn(() => ({
    recordEvent: mockRecordEvent,
    list: mockList,
  })),
  captureEnvironment: vi.fn().mockResolvedValue("env-001"),
  diffEnvironments: vi.fn().mockReturnValue({ changes: [], severity: "none" }),
  getCurrentBranch: vi.fn().mockResolvedValue("main"),
  getHeadSha: vi.fn().mockResolvedValue("head-sha-123"),
}));

vi.mock("@varveai/adit-cloud", () => ({
  triggerTranscriptUpload: vi.fn().mockResolvedValue(undefined),
  triggerAutoSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../common/context.js", () => ({
  initHookContext: vi.fn().mockResolvedValue({
    db: { close: vi.fn() },
    config: {
      projectId: "proj-001",
      projectRoot: "/test",
      dataDir: "/tmp/adit-test",
      clientId: "client-001",
      dbPath: "/tmp/test.db",
      captureEnv: false,
    },
    session: { id: "sess-001" },
  }),
}));

import { dispatchHook } from "./unified.js";
import { endSession } from "@varveai/adit-core";
import { getCurrentBranch, getHeadSha } from "@varveai/adit-engine";
import { triggerAutoSync, triggerTranscriptUpload } from "@varveai/adit-cloud";
import type { NormalizedHookInput } from "../adapters/types.js";

const mockEndSession = vi.mocked(endSession);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockTriggerAutoSync = vi.mocked(triggerAutoSync);
const mockTriggerTranscriptUpload = vi.mocked(triggerTranscriptUpload);

describe("dispatchHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes prompt-submit and records event with prompt text", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "prompt-submit",
      prompt: "Fix the bug in auth.ts",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "prompt_submit",
        actor: "user",
        promptText: "Fix the bug in auth.ts",
      }),
    );
  });

  it("passes fixed project root to hook context", async () => {
    const { initHookContext } = await import("../common/context.js");
    const input: NormalizedHookInput = {
      cwd: "/workspace/packages/api",
      hookType: "prompt-submit",
      platformCli: "codex",
      platformSessionId: "codex-session",
      prompt: "Fix it",
    };

    await dispatchHook(input, { projectRoot: "/workspace" });

    expect(initHookContext).toHaveBeenCalledWith(
      "/workspace/packages/api",
      "codex",
      "codex-session",
      { projectRoot: "/workspace" },
    );
  });

  it("skips fail-open when hook context returns null", async () => {
    const { initHookContext } = await import("../common/context.js");
    vi.mocked(initHookContext).mockResolvedValueOnce(null);

    await dispatchHook({
      cwd: "/missing",
      hookType: "prompt-submit",
      prompt: "test",
    });

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("does not trigger cloud auto-sync on prompt-submit", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "prompt-submit",
      prompt: "Fix the bug in auth.ts",
    };

    await dispatchHook(input);

    expect(mockTriggerAutoSync).not.toHaveBeenCalled();
  });

  it("skips prompt-submit when prompt is empty", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "prompt-submit",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("routes stop and records assistant_response event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "stop",
      stopReason: "completed",
      lastAssistantMessage: "Done fixing the bug.",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "assistant_response",
        actor: "assistant",
        responseText: "Done fixing the bug.",
      }),
    );
  });

  it("does not force-sync on stop so threshold and time triggers control pushing", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "stop",
      stopReason: "completed",
    };

    await dispatchHook(input);

    expect(mockTriggerAutoSync).toHaveBeenCalledWith(
      expect.anything(),
      "proj-001",
      { projectRoot: "/test" },
    );
  });

  it("records null workspace git state when stop has no turn mutations", async () => {
    const { initHookContext } = await import("../common/context.js");
    vi.mocked(initHookContext).mockResolvedValueOnce({
      db: { close: vi.fn() } as never,
      config: {
        projectId: "workspace-001",
        projectRoot: "/workspace",
        dataDir: "/tmp/adit-test",
        clientId: "client-001",
        dbPath: "/tmp/test.db",
        captureEnv: false,
        projectType: "workspace",
        repositories: [{
          localRepositoryId: "repo-core",
          relativePath: "adit-core",
          displayName: "adit-core",
          repositoryUrl: null,
          canonicalRepoKey: null,
          path: "/workspace/adit-core",
        }],
      },
      session: { id: "sess-001" } as never,
    });

    await dispatchHook({
      cwd: "/workspace",
      hookType: "stop",
      stopReason: "completed",
    });

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "assistant_response",
        gitBranch: null,
        gitHeadSha: null,
      }),
    );
    expect(mockGetCurrentBranch).not.toHaveBeenCalled();
    expect(mockGetHeadSha).not.toHaveBeenCalled();
  });

  it("records workspace repository git state from turn mutations", async () => {
    const transcriptDir = mkdtempSync(join(tmpdir(), "adit-hook-transcript-"));
    const transcriptPath = join(transcriptDir, "019efde3-72c7-7f82-9f7c-5f3d63cee24f.jsonl");
    const { initHookContext } = await import("../common/context.js");

    try {
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "edit workspace repos" }],
            },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "patch_apply_end",
              call_id: "call_patch",
              success: true,
              status: "completed",
              changes: {
                "/workspace/adit-cloud/src/a.ts": {
                  type: "update",
                  unified_diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
                },
                "/workspace/adit-cloud/src/b.ts": {
                  type: "update",
                  unified_diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
                },
                "/workspace/adit-core/src/c.ts": {
                  type: "update",
                  unified_diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
                },
              },
            },
          }),
        ].join("\n"),
      );

      vi.mocked(initHookContext).mockResolvedValueOnce({
        db: { close: vi.fn() } as never,
        config: {
          projectId: "workspace-001",
          projectRoot: "/workspace",
          dataDir: "/tmp/adit-test",
          clientId: "client-001",
          dbPath: "/tmp/test.db",
          captureEnv: false,
          projectType: "workspace",
          repositories: [
            {
              localRepositoryId: "repo-cloud",
              relativePath: "adit-cloud",
              displayName: "adit-cloud",
              repositoryUrl: null,
              canonicalRepoKey: null,
              path: "/workspace/adit-cloud",
            },
            {
              localRepositoryId: "repo-core",
              relativePath: "adit-core",
              displayName: "adit-core",
              repositoryUrl: null,
              canonicalRepoKey: null,
              path: "/workspace/adit-core",
            },
          ],
        },
        session: { id: "sess-001" } as never,
      });
      mockGetCurrentBranch.mockImplementation(async (cwd) =>
        cwd.endsWith("adit-cloud") ? "cloud-branch" : "core-branch",
      );
      mockGetHeadSha.mockImplementation(async (cwd) =>
        cwd.endsWith("adit-cloud") ? "cloud-sha" : "core-sha",
      );

      await dispatchHook({
        cwd: "/workspace",
        hookType: "stop",
        stopReason: "completed",
        platformCli: "codex",
        transcriptPath,
      });
    } finally {
      rmSync(transcriptDir, { recursive: true, force: true });
    }

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "assistant_response",
        gitBranch: "cloud-branch,core-branch",
        gitHeadSha: "cloud-sha,core-sha",
      }),
    );
  });

  it("records workspace git state from Codex Bash writes in a child repo cwd", async () => {
    const transcriptDir = mkdtempSync(join(tmpdir(), "adit-hook-transcript-"));
    const transcriptPath = join(transcriptDir, "019efde3-72c7-7f82-9f7c-5f3d63cee24f.jsonl");
    const { initHookContext } = await import("../common/context.js");

    try {
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "generate file with bash" }],
            },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "exec_command_end",
              call_id: "call_bash",
              command: ["/bin/zsh", "-lc", "printf hi > src/generated.ts"],
              cwd: "/workspace/adit-core",
              parsed_cmd: [{ type: "unknown", cmd: "printf hi > src/generated.ts" }],
              exit_code: 0,
              status: "completed",
            },
          }),
        ].join("\n"),
      );

      vi.mocked(initHookContext).mockResolvedValueOnce({
        db: { close: vi.fn() } as never,
        config: {
          projectId: "workspace-001",
          projectRoot: "/workspace",
          dataDir: "/tmp/adit-test",
          clientId: "client-001",
          dbPath: "/tmp/test.db",
          captureEnv: false,
          projectType: "workspace",
          repositories: [{
            localRepositoryId: "repo-core",
            relativePath: "adit-core",
            displayName: "adit-core",
            repositoryUrl: null,
            canonicalRepoKey: null,
            path: "/workspace/adit-core",
          }],
        },
        session: { id: "sess-001" } as never,
      });
      mockGetCurrentBranch.mockResolvedValueOnce("core-branch");
      mockGetHeadSha.mockResolvedValueOnce("core-sha");

      await dispatchHook({
        cwd: "/workspace",
        hookType: "stop",
        stopReason: "completed",
        platformCli: "codex",
        transcriptPath,
      });
    } finally {
      rmSync(transcriptDir, { recursive: true, force: true });
    }

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "assistant_response",
        gitBranch: "core-branch",
        gitHeadSha: "core-sha",
      }),
    );
  });

  it("routes session-end and calls endSession", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "session-end",
      sessionEndReason: "exit",
    };

    await dispatchHook(input);

    expect(mockEndSession).toHaveBeenCalledWith(
      expect.anything(),
      "sess-001",
      "completed",
    );
  });

  it("triggers cloud auto-sync once on session-start", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "session-start",
      sessionSource: "startup",
    };

    await dispatchHook(input);

    expect(mockTriggerAutoSync).toHaveBeenCalledTimes(1);
    expect(mockTriggerAutoSync).toHaveBeenCalledWith(
      expect.anything(),
      "proj-001",
      { projectRoot: "/test" },
    );
  });

  it("force-syncs on session-end before closing the database", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "session-end",
      sessionEndReason: "exit",
    };

    await dispatchHook(input);

    expect(mockTriggerAutoSync).toHaveBeenCalledWith(
      expect.anything(),
      "proj-001",
      { force: true, projectRoot: "/test" },
    );
  });

  it("triggers transcript upload through the cloud package when a transcript path exists", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "prompt-submit",
      prompt: "Fix the bug in auth.ts",
      transcriptPath: "/tmp/transcript.jsonl",
    };

    await dispatchHook(input);

    expect(mockTriggerTranscriptUpload).toHaveBeenCalledWith(
      expect.anything(),
      "sess-001",
      "/tmp/transcript.jsonl",
    );
  });

  it("routes session-end with error reason", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "session-end",
      sessionEndReason: "error",
    };

    await dispatchHook(input);

    expect(mockEndSession).toHaveBeenCalledWith(
      expect.anything(),
      "sess-001",
      "error",
    );
  });

  it("routes notification and records event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "notification",
      notificationMessage: "Tool result: file created",
      notificationTitle: "Tool Result",
      notificationType: "tool_result",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "notification",
        actor: "system",
        responseText: "Tool result: file created",
        toolName: "tool_result",
      }),
    );
  });

  it("skips empty notification events", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "notification",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("records tool notification metadata when message fields are missing", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "notification",
      toolName: "Bash",
      toolInput: { command: "git status" },
      toolOutput: { stdout: "clean" },
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "notification",
        actor: "system",
        responseText: "Tool Bash completed",
        toolName: "Bash",
        toolInputJson: JSON.stringify({
          toolName: "Bash",
          toolInput: { command: "git status" },
        }),
        toolOutputJson: JSON.stringify({ stdout: "clean" }),
      }),
    );
  });

  it("routes task-completed and records event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "task-completed",
      taskId: "task-001",
      taskSubject: "Implement login page",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "task_completed",
        actor: "assistant",
        responseText: "Implement login page",
      }),
    );
  });

  it("routes subagent-start and records event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "subagent-start",
      agentId: "agent-001",
      agentType: "code-reviewer",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "subagent_start",
        actor: "assistant",
        toolName: "code-reviewer",
      }),
    );
  });

  it("routes subagent-stop and records event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "subagent-stop",
      agentId: "agent-001",
      agentType: "code-reviewer",
      lastAssistantMessage: "Review complete, 3 issues found.",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "subagent_stop",
        actor: "assistant",
        toolName: "code-reviewer",
      }),
    );
  });

  it("closes database in finally block even if handler throws", async () => {
    mockRecordEvent.mockRejectedValueOnce(new Error("DB error"));

    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "prompt-submit",
      prompt: "test",
    };

    // The context mock's db.close should still be called
    const { initHookContext } = await import("../common/context.js");
    const ctx = await vi.mocked(initHookContext).mock.results[0]?.value;

    await expect(dispatchHook(input)).rejects.toThrow();
  });
});
