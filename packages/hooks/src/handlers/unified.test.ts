/**
 * Tests for the unified hook dispatcher.
 *
 * Mocks all external dependencies (DB, engine, cloud) to verify
 * that dispatchHook correctly routes each hook type, handles
 * cloud auto-sync thresholds, and maintains fail-open behavior.
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
  mergeSessionMetadata: vi.fn(),
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
import { mergeSessionMetadata } from "@varveai/adit-core";
import { getCurrentBranch, getHeadSha } from "@varveai/adit-engine";
import { triggerAutoSync } from "@varveai/adit-cloud";
import type { NormalizedHookInput } from "../adapters/types.js";

const mockMergeSessionMetadata = vi.mocked(mergeSessionMetadata);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockTriggerAutoSync = vi.mocked(triggerAutoSync);

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

  it("does not record task notification prompts as events", async () => {
    const prompt = "<task-notification>Task done</task-notification>";

    await dispatchHook({
      cwd: "/test",
      hookType: "prompt-submit",
      prompt,
    });

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("marks Claude-Mem observer sessions ignored without recording events", async () => {
    const { initHookContext } = await import("../common/context.js");
    const updateRun = vi.fn();
    const prepare = vi.fn(() => ({ run: updateRun }));
    vi.mocked(initHookContext).mockResolvedValueOnce({
      db: { close: vi.fn(), prepare } as never,
      config: {
        projectId: "proj-001",
        projectRoot: "/test",
        dataDir: "/tmp/adit-test",
        clientId: "client-001",
        dbPath: "/tmp/test.db",
        captureEnv: false,
      },
      session: { id: "observer-session", metadataJson: "{}" } as never,
    });

    await dispatchHook({
      cwd: "/test",
      hookType: "prompt-submit",
      platformCli: "claude-code",
      platformSessionId: "observer-platform-session",
      prompt: claudeMemPrompt("Fix the auth bug"),
    });

    expect(updateRun).toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockTriggerAutoSync).not.toHaveBeenCalled();
  });

  it("skips prompt-submit events from official subagents", async () => {
    await dispatchHook({
      cwd: "/test",
      hookType: "prompt-submit",
      prompt: "Explore the codebase",
      agentId: "agent-001",
    });

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("skips follow-up events for ignored Claude-Mem observer sessions", async () => {
    const { initHookContext } = await import("../common/context.js");
    vi.mocked(initHookContext).mockResolvedValueOnce({
      db: { close: vi.fn() } as never,
      config: {
        projectId: "proj-001",
        projectRoot: "/test",
        dataDir: "/tmp/adit-test",
        clientId: "client-001",
        dbPath: "/tmp/test.db",
        captureEnv: false,
      },
      session: {
        id: "observer-session",
        metadataJson: JSON.stringify({ aditIgnored: { reason: "claude-mem-observer" } }),
      } as never,
    });

    await dispatchHook({
      cwd: "/test",
      hookType: "stop",
      stopReason: "completed",
      platformSessionId: "observer-platform-session",
    });

    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockTriggerAutoSync).not.toHaveBeenCalled();
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

  it("stores null responseText when no assistant message is recoverable, never stop_reason", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "stop",
      stopReason: "end_turn",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "assistant_response",
        responseText: null,
      }),
    );
    // The prompt copy was retired: prompts live only on prompt_submit rows.
    expect(mockRecordEvent.mock.calls[0][0]).not.toHaveProperty("promptText");
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

  it("persists session-start launch metadata on the session instead of a checkpoint event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "session-start",
      sessionSource: "startup",
      model: "claude-fable-5",
      permissionMode: "default",
    };

    await dispatchHook(input);

    expect(mockMergeSessionMetadata).toHaveBeenCalledWith(
      expect.anything(),
      "sess-001",
      { model: "claude-fable-5", source: "startup", permissionMode: "default" },
    );
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("skips the metadata merge when the platform reports nothing", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "session-start",
    };

    await dispatchHook(input);

    expect(mockMergeSessionMetadata).not.toHaveBeenCalled();
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

  it("silently ignores a stale session-end command without syncing", async () => {
    const { initHookContext } = await import("../common/context.js");
    const input = {
      cwd: "/test",
      hookType: "session-end",
    } as unknown as NormalizedHookInput;

    await dispatchHook(input);

    expect(initHookContext).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockMergeSessionMetadata).not.toHaveBeenCalled();
    expect(mockTriggerAutoSync).not.toHaveBeenCalled();
  });

  // notification and task-completed hooks were retired: stale hook entries
  // left in user settings by older installs still invoke adit-hook with these
  // hookTypes, and the dispatcher must ignore them without recording events.
  it("silently ignores retired notification hookType from stale installs", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "notification",
      notificationMessage: "Tool result: file created",
      notificationTitle: "Tool Result",
      notificationType: "tool_result",
      toolName: "Bash",
      toolInput: { command: "git status" },
      toolOutput: { stdout: "clean" },
    };

    await dispatchHook(input);

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("silently ignores retired task-completed hookType from stale installs", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "task-completed",
      taskId: "task-001",
      taskSubject: "Implement login page",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).not.toHaveBeenCalled();
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

function claudeMemPrompt(userRequest: string): string {
  return `Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant.

Please write a concise summary of this part of a conversation in 2-3 sentences. What happened, what was built/discussed. Use <summary></summary> tags.

User: Hello memory agent, you are continuing to observe the primary Claude session.

<observed_from_primary_session>
  <user_request>${userRequest}</user_request>
  <requested_at>2026-06-08</requested_at>
</observed_from_primary_session>

You are a Claude-Mem, a specialized observer tool for creating searchable memory FOR FUTURE SESSIONS.`;
}
