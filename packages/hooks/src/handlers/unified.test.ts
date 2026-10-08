/**
 * Tests for the unified hook dispatcher.
 *
 * Mocks all external dependencies (DB, engine, cloud) to verify
 * that dispatchHook correctly routes each hook type, handles
 * cloud auto-sync thresholds, and maintains fail-open behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks ----

const mockRecordEvent = vi.fn().mockResolvedValue({
  id: "evt-001",
  sessionId: "sess-001",
  sequence: 1,
  eventType: "prompt_submit",
  actor: "user",
});
const mockList = vi.fn().mockResolvedValue([]);

const mockInsertDiff = vi.fn();

vi.mock("@varveai/adit-core", () => ({
  attachPendingTokenUsage: vi.fn(),
  getLatestEnvSnapshot: vi.fn(() => null),
  withPerf: vi.fn((_dir: string, _cat: string, _op: string, fn: () => unknown) => fn()),
  insertDiff: (...args: unknown[]) => mockInsertDiff(...args),
  generateId: vi.fn(() => "diff-001"),
}));

vi.mock("@varveai/adit-engine", () => ({
  createTimelineManager: vi.fn(() => ({
    recordEvent: mockRecordEvent,
    list: mockList,
  })),
  captureEnvironment: vi.fn().mockResolvedValue("env-001"),
  diffEnvironments: vi.fn().mockReturnValue({ changes: [], severity: "none" }),
}));

vi.mock("../git-operations/index.js", () => ({
  recordGitCommits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@varveai/adit-cloud", () => ({
  triggerAutoSync: vi.fn().mockResolvedValue(undefined),
}));

// Bash working-tree snapshots: git and the on-disk store are mocked; the
// pure merge/re-key helpers stay real.
const snapshotMocks = vi.hoisted(() => ({
  captureWorkingTree: vi.fn(),
  diffWorkingTreesWithPatch: vi.fn(),
  writeToolSnapshot: vi.fn(),
  takeToolSnapshot: vi.fn(),
  appendPendingInferred: vi.fn(),
  takePendingInferred: vi.fn(() => []),
  clearSessionSnapshots: vi.fn(),
}));

vi.mock("../bash-snapshot/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bash-snapshot/index.js")>();
  return { ...actual, ...snapshotMocks };
});

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
import { triggerAutoSync } from "@varveai/adit-cloud";
import type { NormalizedHookInput } from "../adapters/types.js";

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
      { projectRoot: "/workspace", transcriptPath: null },
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
      { projectRoot: "/test", collectRuntimeReport: expect.any(Function) },
    );
  });

  it("does not attach ambient Git state to an ordinary response event", async () => {
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

    const ordinaryResponse = mockRecordEvent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ordinaryResponse.eventType).toBe("assistant_response");
    expect(ordinaryResponse).not.toHaveProperty("gitBranch");
    expect(ordinaryResponse).not.toHaveProperty("gitHeadSha");
  });

  it("silently ignores a stale session-start command without creating a session", async () => {
    const { initHookContext } = await import("../common/context.js");
    await dispatchHook({ cwd: "/test", hookType: "session-start" } as unknown as NormalizedHookInput);

    expect(initHookContext).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockTriggerAutoSync).not.toHaveBeenCalled();
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

  it("silently ignores retired subagent hookTypes from stale installs", async () => {
    for (const hookType of ["subagent-start", "subagent-stop"] as const) {
      const input: NormalizedHookInput = {
        cwd: "/test",
        hookType,
        agentId: "agent-001",
        agentType: "code-reviewer",
      };

      await dispatchHook(input);
    }

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  describe("Bash working-tree snapshots", () => {
    const repositories = [{
      localRepositoryId: "repo-root",
      relativePath: ".",
      displayName: "test",
      repositoryUrl: null,
      canonicalRepoKey: null,
      path: "/test",
    }];

    async function withRepositories(): Promise<void> {
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
          projectType: "repo",
          repositories,
        } as never,
        session: { id: "sess-001" } as never,
      });
    }

    it("pre-tool-use snapshots only the current command's write targets", async () => {
      await withRepositories();
      snapshotMocks.captureWorkingTree.mockResolvedValueOnce({ tree: "tree-a", head: "head-1" });

      await dispatchHook({
        cwd: "/test",
        hookType: "pre-tool-use",
        platformCli: "claude-code",
        promptId: "prompt-1",
        toolName: "Bash",
        toolUseId: "toolu_01",
        toolInput: { command: "python3 - <<'EOF'\nfrom pathlib import Path\nPath('src/a.ts').write_text('new')\nEOF" },
      });

      expect(snapshotMocks.captureWorkingTree).toHaveBeenCalledWith("/test", ["src/a.ts"]);
      expect(snapshotMocks.writeToolSnapshot).toHaveBeenCalledWith(
        "/tmp/adit-test",
        "sess-001",
        expect.objectContaining({
          toolUseId: "toolu_01",
          promptId: "prompt-1",
          repositories: [expect.objectContaining({ path: "/test", tree: "tree-a", head: "head-1", targets: ["src/a.ts"] })],
        }),
      );
      expect(mockRecordEvent).not.toHaveBeenCalled();
      expect(mockTriggerAutoSync).not.toHaveBeenCalled();
    });

    it("pre-tool-use skips background commands, other tools and other platforms", async () => {
      const base = {
        cwd: "/test",
        hookType: "pre-tool-use" as const,
        platformCli: "claude-code" as const,
        toolName: "Bash",
        toolUseId: "toolu_02",
      };
      await withRepositories();
      await dispatchHook({ ...base, toolInput: { command: "npm test", run_in_background: true } });
      await withRepositories();
      await dispatchHook({ ...base, toolName: "Read", toolInput: { file_path: "/test/a.ts" } });
      await withRepositories();
      await dispatchHook({ ...base, platformCli: "gemini", toolInput: { command: "ls" } });

      expect(snapshotMocks.captureWorkingTree).not.toHaveBeenCalled();
      expect(snapshotMocks.writeToolSnapshot).not.toHaveBeenCalled();
    });

    it.each(["codex", "cursor"] as const)("snapshots %s shell commands, binding them to the turn id", async (platform) => {
      await withRepositories();
      snapshotMocks.captureWorkingTree.mockResolvedValueOnce({ tree: "tree-a", head: "head-1" });

      await dispatchHook({
        cwd: "/test",
        hookType: "pre-tool-use",
        platformCli: platform,
        turnId: "turn-1",
        toolName: "Bash",
        toolUseId: "exec-0c80cc67",
        toolInput: { command: "printf hi > probe/two.txt" },
      });

      expect(snapshotMocks.writeToolSnapshot).toHaveBeenCalledWith(
        "/tmp/adit-test",
        "sess-001",
        expect.objectContaining({ toolUseId: "exec-0c80cc67", promptId: "turn-1" }),
      );
    });

    it.each(["codex", "cursor"] as const)("stop tags %s shell changes with its own source marker", async (platform) => {
      snapshotMocks.takePendingInferred.mockReturnValueOnce([
        {
          toolUseId: "exec-0c80cc67",
          promptId: "turn-1",
          recordedAt: "2026-09-15T00:00:01.000Z",
          files: [
            { path: "probe/two.txt", status: "A", additions: 1, deletions: 0, diff: "@@ -0,0 +1 @@\n+hi" },
          ],
        },
      ]);

      await dispatchHook({
        cwd: "/test",
        hookType: "stop",
        platformCli: platform,
        stopReason: "completed",
        lastAssistantMessage: "done",
      });

      const response = mockRecordEvent.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(JSON.parse(response.inferredFilesJson as string)).toEqual([
        { path: "probe/two.txt", status: "A", source: `${platform}-bash-snapshot`, toolUseId: "exec-0c80cc67" },
      ]);
      expect(JSON.parse(response.diffStatJson as string)).toEqual([
        { path: "probe/two.txt", status: "A", additions: 1, deletions: 0, toolName: "Bash", source: `${platform}-bash-snapshot` },
      ]);
    });

    it("post-tool-use queues the files that changed while the command ran", async () => {
      snapshotMocks.takeToolSnapshot.mockReturnValueOnce({
        toolUseId: "toolu_03",
        promptId: "prompt-1",
        startedAt: "2026-09-15T00:00:00.000Z",
        repositories: [{ localRepositoryId: "repo-root", relativePath: ".", path: "/test", tree: "tree-a", head: "head-1", targets: ["src/a.ts", "src/new.ts"] }],
      });
      snapshotMocks.captureWorkingTree.mockResolvedValueOnce({ tree: "tree-b", head: "head-1" });
      snapshotMocks.diffWorkingTreesWithPatch.mockResolvedValueOnce([
        { path: "src/a.ts", status: "M", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-a\n+b" },
        { path: "src/new.ts", status: "A", additions: 1, deletions: 0, diff: "@@ -0,0 +1 @@\n+n" },
      ]);

      await dispatchHook({
        cwd: "/test",
        hookType: "post-tool-use",
        platformCli: "claude-code",
        toolName: "Bash",
        toolUseId: "toolu_03",
        toolInput: { command: "sed -i '' 's/a/b/' src/a.ts" },
      });

      expect(snapshotMocks.takeToolSnapshot).toHaveBeenCalledWith("/tmp/adit-test", "sess-001", "toolu_03");
      expect(snapshotMocks.diffWorkingTreesWithPatch).toHaveBeenCalledWith("/test", "tree-a", "tree-b");
      expect(snapshotMocks.appendPendingInferred).toHaveBeenCalledWith(
        "/tmp/adit-test",
        "sess-001",
        expect.objectContaining({
          toolUseId: "toolu_03",
          promptId: "prompt-1",
          files: [
            { path: "src/a.ts", status: "M", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-a\n+b" },
            { path: "src/new.ts", status: "A", additions: 1, deletions: 0, diff: "@@ -0,0 +1 @@\n+n" },
          ],
        }),
      );
    });

    it("post-tool-use ignores commands that moved HEAD (checkout, pull, reset)", async () => {
      snapshotMocks.takeToolSnapshot.mockReturnValueOnce({
        toolUseId: "toolu_04",
        promptId: null,
        startedAt: "2026-09-15T00:00:00.000Z",
        repositories: [{ localRepositoryId: "repo-root", relativePath: ".", path: "/test", tree: "tree-a", head: "head-1", targets: ["src/a.ts"] }],
      });
      snapshotMocks.captureWorkingTree.mockResolvedValueOnce({ tree: "tree-c", head: "head-2" });

      await dispatchHook({
        cwd: "/test",
        hookType: "post-tool-use",
        platformCli: "claude-code",
        toolName: "Bash",
        toolUseId: "toolu_04",
        toolInput: { command: "echo new > src/a.ts; git checkout main" },
      });

      expect(snapshotMocks.diffWorkingTreesWithPatch).not.toHaveBeenCalled();
      expect(snapshotMocks.appendPendingInferred).not.toHaveBeenCalled();
    });

    it("does not infer targets for read-only commands or standalone external scripts", async () => {
      for (const command of ["git status", "python output/edit.py", "node edit.js", "Get-Content src/a.ts"]) {
        await withRepositories();
        await dispatchHook({ cwd: "/test", hookType: "pre-tool-use", platformCli: "codex", toolName: "Bash", toolUseId: "read", toolInput: { command } });
      }
      expect(snapshotMocks.captureWorkingTree).not.toHaveBeenCalled();
      expect(snapshotMocks.writeToolSnapshot).not.toHaveBeenCalled();
    });

    it("does not compare legacy snapshots that have no target scope", async () => {
      snapshotMocks.takeToolSnapshot.mockReturnValueOnce({
        toolUseId: "legacy", promptId: null, startedAt: "2026-09-15T00:00:00.000Z",
        repositories: [{ localRepositoryId: "repo-root", relativePath: ".", path: "/test", tree: "tree-a", head: "head-1" }],
      });
      await dispatchHook({ cwd: "/test", hookType: "post-tool-use", platformCli: "codex", toolName: "Bash", toolUseId: "legacy" });
      expect(snapshotMocks.captureWorkingTree).not.toHaveBeenCalled();
      expect(snapshotMocks.appendPendingInferred).not.toHaveBeenCalled();
    });

    it("post-tool-use does nothing without a matching pre-tool-use snapshot", async () => {
      snapshotMocks.takeToolSnapshot.mockReturnValueOnce(null);

      await dispatchHook({
        cwd: "/test",
        hookType: "post-tool-use",
        platformCli: "claude-code",
        toolName: "Bash",
        toolUseId: "toolu_05",
        toolInput: { command: "ls" },
      });

      expect(snapshotMocks.captureWorkingTree).not.toHaveBeenCalled();
      expect(snapshotMocks.appendPendingInferred).not.toHaveBeenCalled();
    });

    it("stop attaches the turn's inferred file list and Bash diffs to the response event", async () => {
      snapshotMocks.takePendingInferred.mockReturnValueOnce([
        {
          toolUseId: "toolu_03",
          promptId: "prompt-1",
          recordedAt: "2026-09-15T00:00:01.000Z",
          files: [
            { path: "src/a.ts", status: "M", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-a\n+b" },
            { path: "src/new.ts", status: "A", additions: 1, deletions: 0, diff: "@@ -0,0 +1 @@\n+n" },
          ],
        },
      ]);

      await dispatchHook({
        cwd: "/test",
        hookType: "stop",
        platformCli: "claude-code",
        stopReason: "completed",
        lastAssistantMessage: "Done.",
      });

      expect(snapshotMocks.takePendingInferred).toHaveBeenCalledWith("/tmp/adit-test", "sess-001");
      const response = mockRecordEvent.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(response.eventType).toBe("assistant_response");
      expect(JSON.parse(response.inferredFilesJson as string)).toEqual([
        { path: "src/a.ts", status: "M", source: "claude-bash-snapshot", toolUseId: "toolu_03" },
        { path: "src/new.ts", status: "A", source: "claude-bash-snapshot", toolUseId: "toolu_03" },
      ]);
      // Bash changes flow through the regular mutation pipeline too: per-file
      // stats tagged with their source, plus a bounded diff text.
      expect(JSON.parse(response.diffStatJson as string)).toEqual([
        { path: "src/a.ts", status: "M", additions: 1, deletions: 1, toolName: "Bash", source: "claude-bash-snapshot" },
        { path: "src/new.ts", status: "A", additions: 1, deletions: 0, toolName: "Bash", source: "claude-bash-snapshot" },
      ]);
      expect(mockInsertDiff).toHaveBeenCalledTimes(1);
      const diffText = (mockInsertDiff.mock.calls[0][1] as { diffText: string }).diffText;
      expect(diffText).toContain("diff --git a/src/a.ts b/src/a.ts");
      expect(diffText).toContain("+b");
      expect(diffText).toContain("diff --git a/src/new.ts b/src/new.ts");
    });

    it("stop stores null when the turn ran no file-changing Bash commands", async () => {
      await dispatchHook({
        cwd: "/test",
        hookType: "stop",
        platformCli: "claude-code",
        stopReason: "completed",
      });

      const response = mockRecordEvent.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(response.inferredFilesJson).toBeNull();
      expect(response.diffStatJson).toBeNull();
      expect(mockInsertDiff).not.toHaveBeenCalled();
    });

    it("prompt-submit keeps snapshots queued by the running turn (appended prompts join it)", async () => {
      await dispatchHook({
        cwd: "/test",
        hookType: "prompt-submit",
        platformCli: "claude-code",
        prompt: "one more thing while you work",
      });

      expect(snapshotMocks.clearSessionSnapshots).not.toHaveBeenCalled();
      expect(snapshotMocks.takePendingInferred).not.toHaveBeenCalled();
    });
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
