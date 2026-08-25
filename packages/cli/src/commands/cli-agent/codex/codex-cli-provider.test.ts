import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  appStart: vi.fn(),
  appRequest: vi.fn(),
  appStop: vi.fn(),
  deferredSystemSkillsStderr: false,
  clearDeferredSystemSkillsStderr: vi.fn(),
  flushDeferredSystemSkillsStderr: vi.fn(),
  appServerOptions: null as null | {
    onNotification?: (message: unknown) => void;
  },
  resumeWatcherOptions: null as null | {
    cwd: string;
    onResume: (threadId: string) => void;
  },
  resumeWatcherClaim: vi.fn(),
  resumeWatcherStop: vi.fn(),
  startResumeWatcher: vi.fn(),
  modelWatcherOptions: null as null | {
    cwd: string;
    onModel: (modelId: string) => void;
  },
  modelWatcherStop: vi.fn(),
  startModelWatcher: vi.fn(),
  savedThreadIds: new Set<string>(),
  isSavedThread: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
}));

vi.mock("./codex-app-server-client.js", () => ({
  CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE: "default_mode_request_user_input",
  CodexAppServerClient: class {
    constructor(options: unknown) {
      mocks.appServerOptions = options as typeof mocks.appServerOptions;
    }

    get isRunning() {
      return true;
    }

    start() {
      return mocks.appStart();
    }

    request(method: string, params: unknown) {
      return mocks.appRequest(method, params);
    }

    stop() {
      return mocks.appStop();
    }

    hasDeferredSystemSkillsStderr() {
      return mocks.deferredSystemSkillsStderr;
    }

    clearDeferredSystemSkillsStderr() {
      mocks.clearDeferredSystemSkillsStderr();
      mocks.deferredSystemSkillsStderr = false;
    }

    flushDeferredSystemSkillsStderr() {
      mocks.flushDeferredSystemSkillsStderr();
      mocks.deferredSystemSkillsStderr = false;
    }
  },
}));

vi.mock("./codex-resume-log-watcher.js", () => ({
  isCodexThreadSavedForCwd: (options: unknown) => mocks.isSavedThread(options),
  readMaxCodexLogId: () => 0,
  startCodexResumeLogWatcher: (options: unknown) => {
    mocks.resumeWatcherOptions = options as typeof mocks.resumeWatcherOptions;
    mocks.startResumeWatcher(options);
    return {
      claimProcessForThread: mocks.resumeWatcherClaim,
      stop: mocks.resumeWatcherStop,
    };
  },
}));

vi.mock("./codex-model-config-watcher.js", () => ({
  startCodexModelConfigWatcher: (options: unknown) => {
    mocks.modelWatcherOptions = options as typeof mocks.modelWatcherOptions;
    mocks.startModelWatcher(options);
    return {
      refresh: vi.fn(),
      stop: mocks.modelWatcherStop,
    };
  },
}));

vi.mock("@varveai/adit-engine", () => ({
  getCurrentBranch: vi.fn(async () => "main"),
}));

import {
  CODEX_LOCAL_WRITER_RELEASE_RETRY_DELAYS_MS,
  CodexCliProvider,
  codexThreadModeOverrides,
  codexTurnModeOverrides,
  normalizeCodexReclaimInput,
  promptInputForCodexMode,
} from "./provider.js";
import { createRelayNotices } from "../relay-console.js";
import {
  LOCAL_CLI_EXIT_WAIT_MS,
  LOCAL_CLI_FORCE_EXIT_WAIT_MS,
} from "./terminal.js";

function mockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CodexCliProvider collaboration context", () => {
  it("persists context without starting a turn and applies it to the next prompt", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "adit-provider-context-"));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      dataDir,
      onEvent: (event) => events.push(event),
    });
    provider.noteLocalSession("019e2110-d96f-7e40-882e-b524fa9148e4");

    try {
      await expect(provider.appendSessionContext({
        sessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        contextEntryId: "context-1",
        requestId: "request-1",
        kind: "collaboration_request",
        content: "Ask Agent B where authentication is implemented.",
      })).resolves.toMatchObject({ appended: true, persisted: true });
      expect(mocks.appRequest).not.toHaveBeenCalledWith("turn/start", expect.anything());

      await provider.takeover();
      await provider.sendPrompt("What did I ask the other agent?");

      expect(mocks.appRequest).toHaveBeenCalledWith("turn/start", expect.objectContaining({
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        input: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Ask Agent B where authentication is implemented."),
          }),
          expect.objectContaining({
            type: "text",
            text: "What did I ask the other agent?",
          }),
        ],
      }));
      expect(events.filter((event) => event.type === "context.applied")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            contextEntryId: "context-1",
            requestId: "request-1",
            sessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
          }),
        }),
      ]);
    } finally {
      provider.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

const DEFAULT_APP_SERVER_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/settings/update",
  "thread/fork",
  "thread/compact/start",
  "skills/list",
  "model/list",
  "mcpServerStatus/list",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
];

function appServerMethodsError(methods = DEFAULT_APP_SERVER_METHODS): Error {
  return new Error(
    `Invalid request: unknown variant \`adit/capabilities/discover\`, expected one of ${
      methods.map((method) => `\`${method}\``).join(", ")
    }`,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.deferredSystemSkillsStderr = false;
  mocks.appServerOptions = null;
  mocks.resumeWatcherOptions = null;
  mocks.modelWatcherOptions = null;
  mocks.savedThreadIds.clear();
  mocks.isSavedThread.mockImplementation((options: unknown) => {
    const threadId = (options as { threadId?: string }).threadId;
    return typeof threadId === "string" && mocks.savedThreadIds.has(threadId);
  });
  mocks.spawn.mockImplementation(() => mockChildProcess());
  mocks.appStart.mockResolvedValue(undefined);
  mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
    if (method === "adit/capabilities/discover") {
      throw appServerMethodsError();
    }
    if (method === "thread/start") {
      return {
        model: "gpt-test",
        thread: { id: "019e2110-d96f-7e40-882e-b524fa9148e4" },
      };
    }
    if (method === "thread/resume") {
      return {
        model: "gpt-test",
        thread: { id: (params as { threadId?: string }).threadId },
      };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    if (method === "skills/list") {
      return {
        data: [
          {
            cwd: (params as { cwds?: string[] }).cwds?.[0] ?? "/tmp/project",
            skills: [
              {
                name: "imagegen",
                description: "Generate images",
                path: "/tmp/skills/imagegen/SKILL.md",
                scope: "system",
                enabled: true,
              },
              {
                name: "git-workflow",
                description: "Use Git safely",
                path: "/tmp/skills/git-workflow/SKILL.md",
                scope: "user",
                enabled: true,
              },
            ],
          },
        ],
      };
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: [
          {
            name: "chrome-devtools",
            tools: {
              list_pages: { name: "list_pages" },
              take_snapshot: { name: "take_snapshot" },
            },
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
      };
    }
    return {};
  });
});

function mockNoMcpServers(): void {
  const original = mocks.appRequest.getMockImplementation();
  mocks.appRequest.mockImplementation((method: string, params: unknown) => {
    if (method === "mcpServerStatus/list") return Promise.resolve({ data: [] });
    return original?.(method, params);
  });
}

describe("normalizeCodexReclaimInput", () => {
  it("preserves normal reclaim input", () => {
    expect(normalizeCodexReclaimInput("/local\n")).toBe("/local\n");
  });

  it("decodes CSI-u reclaim input left by Codex terminal mode", () => {
    const encoded = "\x1b[I\x1b[O\x1b[47u\x1b[108u\x1b[111u\x1b[99u\x1b[97u\x1b[108u\x1b[13u";

    expect(normalizeCodexReclaimInput(encoded)).toBe("/local\n");
  });

  it("decodes modified CSI-u keys and strips unrelated CSI escapes", () => {
    const encoded = "\x1b[?1004h\x1b[47;1:3u\x1b[108;1:3u\x1b[111;1:3u\x1b[99;1:3u\x1b[97;1:3u\x1b[108;1:3u";

    expect(normalizeCodexReclaimInput(encoded)).toBe("/local");
  });

  it("decodes CSI-u Ctrl+C left by Codex terminal mode", () => {
    expect(normalizeCodexReclaimInput("\x1b[99;5u")).toBe("\u0003");
    expect(normalizeCodexReclaimInput("\x1b[99;1:5u")).toBe("\u0003");
  });
});

describe("Codex prompt modes", () => {
  it("wraps plan prompts with read-only planning instructions", () => {
    const prompt = promptInputForCodexMode("add login", "plan");

    expect(prompt).toContain("ADIT Plan mode is active.");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("User request:\nadd login");
  });

  it("leaves build prompts unchanged", () => {
    expect(promptInputForCodexMode("add login", "build")).toBe("add login");
  });

  it("uses read-only sandbox overrides in plan mode", () => {
    expect(codexThreadModeOverrides("plan")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      config: {
        "features.default_mode_request_user_input": true,
      },
    });
    expect(codexTurnModeOverrides("plan")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
    });
  });

  it("uses full-access sandbox overrides in build mode", () => {
    expect(codexThreadModeOverrides("build")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      config: {
        "features.default_mode_request_user_input": true,
      },
    });
    expect(codexTurnModeOverrides("build")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
    });
  });
});

describe("CodexCliProvider takeover", () => {
  it("runs collaboration consultations read-only and emits the bound answer", async () => {
    mockNoMcpServers();
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const dataDir = mkdtempSync(join(tmpdir(), "adit-codex-collaboration-run-"));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      dataDir,
      onEvent: (event) => events.push(event),
    });
    provider.noteLocalSession(threadId);
    await provider.takeover();
    await provider.appendSessionContext({
      sessionId: threadId,
      contextEntryId: "33333333-3333-4333-8333-333333333333",
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "collaboration_result",
      content: "Pending context for the next normal prompt.",
    });

    const started = await provider.startCollaborationConsultation({
      requestId: "request-1",
      attemptId: "attempt-1",
      runId: "run-1",
      protocolVersion: "v1",
      mode: "consultation",
      targetSessionId: threadId,
      question: "Where is authentication configured?",
    });
    expect(started).toEqual({ sessionId: threadId, providerRunId: "turn-1" });
    expect(mocks.appRequest).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("read-only consultation"),
        }),
      ]),
    }));
    const collaborationTurn = mocks.appRequest.mock.calls.find(([method]) => method === "turn/start")?.[1] as {
      input?: Array<{ text?: string }>;
    };
    expect(collaborationTurn.input?.some((item) => item.text?.includes("Pending context"))).toBe(false);
    expect(events.some((event) => event.type === "context.applied")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "collaboration.prepared",
      payload: expect.objectContaining({
        sessionId: threadId,
        guardrailReceipt: expect.objectContaining({
          stage: "prepared",
          promptMode: "plan",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        }),
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "collaboration.started",
      payload: expect.objectContaining({
        requestId: "request-1",
        attemptId: "attempt-1",
        runId: "run-1",
        protocolVersion: "v1",
        mode: "consultation",
        guardrailReceipt: expect.objectContaining({
          stage: "active",
          policyVersion: "codex-consultation-read-only-v1",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        }),
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "message",
      payload: expect.objectContaining({
        role: "user",
        text: "Where is authentication configured?",
      }),
    }));

    mocks.appServerOptions?.onNotification?.({
      method: "item/completed",
      params: {
        threadId,
        item: { id: "answer-1", type: "agentMessage", text: "Authentication is in src/auth.ts." },
      },
    });
    expect(events.some((event) => event.type === "collaboration.completed")).toBe(false);
    mocks.appServerOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId, turn: { id: "turn-1", status: "completed" } },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "collaboration.completed",
      payload: expect.objectContaining({
        requestId: "request-1",
        attemptId: "attempt-1",
        runId: "run-1",
        finalMessageId: "answer-1",
        answer: "Authentication is in src/auth.ts.",
        answerComplete: true,
      }),
    }));

    await provider.sendPrompt("Continue with the normal task.");
    const normalTurn = mocks.appRequest.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1] as {
      input?: Array<{ text?: string }>;
    };
    expect(normalTurn.input?.some((item) => item.text?.includes("Pending context"))).toBe(true);
    expect(events.some((event) => event.type === "context.applied")).toBe(true);

    provider.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows read-only collaboration when Codex exposes MCP servers", async () => {
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession(threadId);
    await provider.takeover();

    await expect(provider.startCollaborationConsultation({
      requestId: "request-mcp",
      attemptId: "attempt-mcp",
      runId: "run-mcp",
      protocolVersion: "v1",
      mode: "consultation",
      targetSessionId: threadId,
      question: "Inspect the current implementation.",
    })).resolves.toEqual({ sessionId: threadId, providerRunId: "turn-1" });

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    }));

    provider.stop();
  });

  it("stops an accepted consultation when Codex omits its Provider run ID", async () => {
    mockNoMcpServers();
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const dataDir = mkdtempSync(join(tmpdir(), "adit-codex-collaboration-invalid-start-"));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const defaultRequest = mocks.appRequest.getMockImplementation();
    mocks.appRequest.mockImplementation((method: string, params: unknown) => {
      if (method === "turn/start") return Promise.resolve({ turn: {} });
      return defaultRequest?.(method, params);
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      dataDir,
      onEvent: (event) => events.push(event),
    });
    provider.noteLocalSession(threadId);
    await provider.takeover();

    await expect(provider.startCollaborationConsultation({
      requestId: "request-invalid-start",
      attemptId: "attempt-invalid-start",
      runId: "run-invalid-start",
      protocolVersion: "v1",
      mode: "consultation",
      targetSessionId: threadId,
      question: "Inspect the current implementation.",
    })).rejects.toThrow("did not return collaboration run identifiers");

    expect(mocks.appStop).toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "collaboration.failed",
      payload: expect.objectContaining({ runId: "run-invalid-start" }),
    }));
    provider.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("marks a user-stopped collaboration with a dedicated failure code", async () => {
    mockNoMcpServers();
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    provider.noteLocalSession(threadId);
    await provider.takeover();
    await provider.startCollaborationConsultation({
      requestId: "request-stop",
      attemptId: "attempt-stop",
      runId: "run-stop",
      protocolVersion: "v1",
      mode: "consultation",
      targetSessionId: threadId,
      question: "Inspect the current implementation.",
    });

    await provider.abort();

    expect(events).toContainEqual(expect.objectContaining({
      type: "collaboration.failed",
      payload: expect.objectContaining({
        requestId: "request-stop",
        runId: "run-stop",
        code: "USER_STOPPED",
      }),
    }));
    expect(mocks.appRequest).toHaveBeenCalledWith("turn/interrupt", {
      threadId,
      turnId: "turn-1",
    });

    provider.stop();
  });

  it("interrupts only the matching timed-out collaboration run", async () => {
    mockNoMcpServers();
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    provider.noteLocalSession(threadId);
    await provider.takeover();
    await provider.startCollaborationConsultation({
      requestId: "request-timeout",
      attemptId: "attempt-timeout",
      runId: "run-timeout",
      protocolVersion: "v1",
      mode: "consultation",
      targetSessionId: threadId,
      question: "Inspect the current implementation.",
    });

    await provider.abortCollaborationConsultation({
      requestId: "request-timeout",
      attemptId: "attempt-timeout",
      runId: "run-timeout",
      code: "RUN_TIMEOUT",
      message: "The collaboration run timed out before completion.",
    });

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/interrupt", {
      threadId,
      turnId: "turn-1",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "collaboration.failed",
      payload: expect.objectContaining({
        requestId: "request-timeout",
        runId: "run-timeout",
        code: "RUN_TIMEOUT",
      }),
    }));

    provider.stop();
  });

  it("refuses a timeout interrupt for a different active collaboration", async () => {
    mockNoMcpServers();
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession(threadId);
    await provider.takeover();
    await provider.startCollaborationConsultation({
      requestId: "request-active",
      attemptId: "attempt-active",
      runId: "run-active",
      protocolVersion: "v1",
      mode: "consultation",
      targetSessionId: threadId,
      question: "Inspect the current implementation.",
    });

    await expect(provider.abortCollaborationConsultation({
      requestId: "request-old",
      attemptId: "attempt-old",
      runId: "run-old",
      code: "RUN_TIMEOUT",
      message: "The collaboration run timed out before completion.",
    })).rejects.toThrow("A different collaboration run is active");
    expect(mocks.appRequest).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());

    provider.stop();
  });

  it("interrupts an active collaboration when the Relay connection closes", async () => {
    mockNoMcpServers();
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    provider.noteLocalSession(threadId);
    await provider.takeover();
    await provider.startCollaborationConsultation({
      requestId: "request-disconnect",
      attemptId: "attempt-disconnect",
      runId: "run-disconnect",
      protocolVersion: "v1",
      mode: "consultation",
      targetSessionId: threadId,
      question: "Inspect the current implementation.",
    });

    await provider.abortCollaborationOnRelayDisconnect();

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/interrupt", {
      threadId,
      turnId: "turn-1",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "collaboration.failed",
      payload: expect.objectContaining({
        requestId: "request-disconnect",
        runId: "run-disconnect",
        code: "EXECUTION_ABORTED",
      }),
    }));

    provider.stop();
  });

  it("fails an active collaboration when local Codex reclaims control", async () => {
    mockNoMcpServers();
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    provider.noteLocalSession(threadId);
    await provider.takeover();
    await provider.startCollaborationConsultation({
      requestId: "request-local",
      attemptId: "attempt-local",
      runId: "run-local",
      protocolVersion: "v1",
      mode: "consultation",
      targetSessionId: threadId,
      question: "Inspect the current implementation.",
    });

    await provider.releaseToLocal();

    expect(events).toContainEqual(expect.objectContaining({
      type: "collaboration.failed",
      payload: expect.objectContaining({
        requestId: "request-local",
        runId: "run-local",
        code: "LOCAL_TAKEOVER_DURING_RUN",
      }),
    }));
    expect(provider.state.owner).toBe("local");

    provider.stop();
  });

  it("updates local active model from Codex config watcher changes", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    expect(mocks.startModelWatcher).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/project" }),
    );

    mocks.modelWatcherOptions?.onModel("gpt-5.5");

    expect(provider.state.activeModelId).toBe("gpt-5.5");
    expect(events).toContainEqual(expect.objectContaining({
      type: "state",
      payload: expect.objectContaining({
        activeModelId: "gpt-5.5",
      }),
    }));

    provider.stop();
    expect(mocks.modelWatcherStop).toHaveBeenCalled();
  });

  it("applies the latest local model to a resumed Web thread before starting a turn", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "adit/capabilities/discover") {
        throw appServerMethodsError();
      }
      if (method === "thread/resume") {
        return {
          model: "gpt-5.5",
          thread: { id: threadId },
        };
      }
      if (method === "thread/settings/update") return {};
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      if (method === "skills/list") return { data: [] };
      if (method === "mcpServerStatus/list") return { data: [] };
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    provider.noteLocalSession(threadId);
    mocks.modelWatcherOptions?.onModel("gpt-5.4");

    await provider.takeover();
    await provider.sendPrompt("hello");

    const calls = mocks.appRequest.mock.calls;
    const settingsIndex = calls.findIndex(([method]) => method === "thread/settings/update");
    const turnStartIndex = calls.findIndex(([method]) => method === "turn/start");
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(turnStartIndex).toBeGreaterThan(settingsIndex);
    expect(calls[settingsIndex]).toEqual([
      "thread/settings/update",
      {
        threadId,
        model: "gpt-5.4",
      },
    ]);
    expect(provider.state.activeModelId).toBe("gpt-5.4");

    mocks.appServerOptions?.onNotification?.({
      method: "item/completed",
      params: {
        threadId,
        item: {
          id: "item-1",
          type: "agentMessage",
          text: "done",
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "message",
      payload: expect.objectContaining({
        role: "assistant",
        modelId: "gpt-5.4",
        text: "done",
      }),
    }));

    provider.stop();
  });

  it("emits Codex context compaction items as internal tool events", async () => {
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    provider.noteLocalSession(threadId);
    await provider.takeover();

    mocks.appServerOptions?.onNotification?.({
      method: "item/started",
      params: {
        threadId,
        item: {
          id: "compact-1",
          type: "contextCompaction",
        },
      },
    });
    mocks.appServerOptions?.onNotification?.({
      method: "item/completed",
      params: {
        threadId,
        item: {
          id: "compact-1",
          type: "contextCompaction",
        },
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool",
      payload: expect.objectContaining({
        sessionId: threadId,
        messageId: `codex-tools-${threadId}`,
        toolUseId: "compact-1",
        toolName: "Context compaction",
        input: { source: "codex" },
        tool_scope: "internal",
        status: "running",
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool",
      payload: expect.objectContaining({
        sessionId: threadId,
        messageId: `codex-tools-${threadId}`,
        toolUseId: "compact-1",
        toolName: "Context compaction",
        input: { source: "codex" },
        tool_scope: "internal",
        output: "Context compaction completed.",
        status: "completed",
      }),
    }));

    provider.stop();
  });

  it("updates local session state when Codex resume is detected before hooks run", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    expect(mocks.startResumeWatcher).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/project", afterLogId: 0 }),
    );
    expect(provider.state.activeSessionId).toBeNull();

    mocks.resumeWatcherOptions?.onResume("019e2110-d96f-7e40-882e-b524fa9148e4");

    expect(mocks.resumeWatcherClaim).toHaveBeenCalledWith(
      "019e2110-d96f-7e40-882e-b524fa9148e4",
    );
    expect(provider.state.activeSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(provider.state.resumeSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(provider.state.sdkSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(events).toContainEqual(expect.objectContaining({
      type: "state",
      payload: expect.objectContaining({
        activeSessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      }),
    }));

    provider.stop();
  });

  it("stops local resume watcher when Web takes over", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();

    expect(mocks.resumeWatcherStop).toHaveBeenCalled();

    provider.stop();
  });

  it("waits for the local Codex process to exit before Web owns the terminal", async () => {
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const child = mockChildProcess();
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    mocks.spawn.mockReturnValueOnce(child);
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession(threadId);

    let settled = false;
    const takeover = provider.takeover().then(() => {
      settled = true;
    });

    await tick();
    expect(settled).toBe(false);
    expect(provider.state.owner).toBe("local");
    expect(mocks.appRequest).not.toHaveBeenCalledWith("thread/resume", expect.anything());

    child.emit("exit", 0, null);
    await takeover;

    expect(provider.state.owner).toBe("web");
    expect(mocks.appRequest).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ threadId }),
    );

    provider.stop();
  });

  it("keeps local control when the Codex process does not exit", async () => {
    vi.useFakeTimers();
    const child = mockChildProcess();
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    mocks.spawn.mockReturnValueOnce(child);
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      const takeover = expect(provider.takeover()).rejects.toMatchObject({
        message: "local Codex did not exit during Web takeover",
        statusCode: 409,
      });
      await vi.advanceTimersByTimeAsync(
        LOCAL_CLI_EXIT_WAIT_MS + LOCAL_CLI_FORCE_EXIT_WAIT_MS,
      );
      await takeover;

      expect(provider.state.owner).toBe("local");
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
      expect(mocks.startResumeWatcher).toHaveBeenCalledTimes(1);
      expect(mocks.resumeWatcherStop).not.toHaveBeenCalled();
      expect(mocks.appRequest).not.toHaveBeenCalledWith("thread/start", expect.anything());
    } finally {
      provider.stop();
      vi.useRealTimers();
    }
  });

  it("emits SIGINT exit when reclaim input receives CSI-u Ctrl+C", async () => {
    const exits: unknown[] = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.on("exit", (event) => exits.push(event));

    await provider.takeover();
    (provider as unknown as { onReclaimInput: (chunk: string) => void }).onReclaimInput("\x1b[99;5u");

    expect(exits).toContainEqual({ code: null, signal: "SIGINT" });
    expect(provider.state.owner).toBe("stopped");
  });

  it("does not emit fixed slash commands on construction", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "slash-commands")).toBe(false);

    provider.stop();
  });

  it("rejects Web takeover after the local Codex CLI exits", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    const child = mocks.spawn.mock.results[0]?.value as EventEmitter;

    child.emit("exit", 0, null);

    expect(provider.state.owner).toBe("stopped");

    await expect(provider.takeover()).rejects.toMatchObject({
      message: "local Codex owner is not available",
      statusCode: 409,
    });
    expect(mocks.appRequest).not.toHaveBeenCalled();

    provider.stop();
  });

  it("hydrates slash commands from app-server methods", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();

    const slashEvent = events.find((event) => event.type === "slash-commands");
    expect(slashEvent?.payload.commands).toEqual([
      { name: "compact", description: "Compress the current Codex thread" },
      { name: "mcp", description: "Show 1 Codex MCP server" },
      { name: "skills", description: "List 2 Codex skills" },
      { name: "fork", description: "Fork the current Codex thread" },
      { name: "model", description: "List available Codex models" },
      { name: "new", description: "Start a new Codex thread" },
      { name: "clear", description: "Start a clean Codex thread" },
      { name: "imagegen", description: "Use Codex skill: Generate images" },
      { name: "git-workflow", description: "Use Codex skill: Use Git safely" },
      { name: "mcp.chrome-devtools", description: "Show Codex MCP server: chrome-devtools" },
    ]);

    provider.stop();
  });

  it("omits slash commands whose app-server methods are missing", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "adit/capabilities/discover") {
        throw appServerMethodsError(["initialize", "thread/start", "skills/list"]);
      }
      if (method === "thread/start") {
        return {
          model: "gpt-test",
          thread: { id: "019e2110-d96f-7e40-882e-b524fa9148e4" },
        };
      }
      if (method === "skills/list") {
        return {
          data: [
            {
              cwd: (params as { cwds?: string[] }).cwds?.[0] ?? "/tmp/project",
              skills: [{ name: "imagegen", enabled: true }],
            },
          ],
        };
      }
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();

    const slashEvent = events.find((event) => event.type === "slash-commands");
    expect((slashEvent?.payload.commands as Array<{ name: string }>).map((command) => command.name)).toEqual([
      "skills",
      "new",
      "clear",
      "imagegen",
    ]);
    await expect(
      provider.handleSlashCommand({ name: "mcp", args: [], raw: "/mcp" }),
    ).rejects.toMatchObject({
      message: "Codex Cloud Coding does not expose /mcp as an executable native command.",
      statusCode: 400,
    });

    provider.stop();
  });

  it("falls back to the standard slash commands when capability discovery fails without blocking takeover", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "adit/capabilities/discover") {
        throw new Error("app-server refused capability probe");
      }
      if (method === "thread/start") {
        return {
          model: "gpt-test",
          thread: { id: "019e2110-d96f-7e40-882e-b524fa9148e4" },
        };
      }
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();

    expect(provider.state.owner).toBe("web");
    const slashEvent = events.find((event) => event.type === "slash-commands");
    expect((slashEvent?.payload.commands as Array<{ name: string }>).map((command) => command.name)).toEqual([
      "compact",
      "mcp",
      "skills",
      "fork",
      "model",
      "new",
      "clear",
    ]);

    provider.stop();
  });

  it("retries skill hydration when Codex rewrites the system skills cache", async () => {
    vi.useFakeTimers();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let skillListCalls = 0;
    mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "adit/capabilities/discover") {
        throw appServerMethodsError();
      }
      if (method === "thread/start") {
        return {
          model: "gpt-test",
          thread: { id: "019e2110-d96f-7e40-882e-b524fa9148e4" },
        };
      }
      if (method === "skills/list") {
        skillListCalls += 1;
        if (skillListCalls === 1) mocks.deferredSystemSkillsStderr = true;
        return {
          data: [
            {
              cwd: (params as { cwds?: string[] }).cwds?.[0] ?? "/tmp/project",
              skills: [
                {
                  name: skillListCalls === 1 ? "partial-skill" : "imagegen",
                  description: "Generate images",
                  enabled: true,
                },
              ],
            },
          ],
        };
      }
      if (method === "mcpServerStatus/list") return { data: [] };
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      const takeover = provider.takeover();
      await vi.advanceTimersByTimeAsync(250);
      await takeover;

      expect(skillListCalls).toBe(2);
      expect(mocks.clearDeferredSystemSkillsStderr).toHaveBeenCalledTimes(1);
      expect(mocks.flushDeferredSystemSkillsStderr).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
        .toContainEqual({ name: "imagegen", description: "Use Codex skill: Generate images" });
    } finally {
      provider.stop();
      vi.useRealTimers();
    }
  });

  it("starts a real empty thread when Web takes over without an active session", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();

    expect(mocks.appRequest).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        cwd: "/tmp/project",
        persistExtendedHistory: true,
      }),
    );
    expect(mocks.appRequest).not.toHaveBeenCalledWith(
      "thread/resume",
      expect.anything(),
    );
    expect(provider.state.owner).toBe("web");
    expect(provider.state.activeSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(provider.state.resumeSessionId).toBeNull();
    expect(provider.state.sdkSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(events.some((event) =>
      event.type === "state" &&
      event.payload.activeSessionId === "019e2110-d96f-7e40-882e-b524fa9148e4"
    )).toBe(true);

    provider.stop();
  });

  it("starts local Codex without resume when Web owns an unsaved empty thread", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();
    mocks.spawn.mockClear();

    await provider.releaseToLocal();

    expect(mocks.isSavedThread).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "codex",
      [],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
    expect(provider.state.owner).toBe("local");
    expect(provider.state.activeSessionId).toBeNull();
    expect(provider.state.resumeSessionId).toBeNull();
    expect(provider.state.sdkSessionId).toBeNull();

    provider.stop();
  });

  it("resumes a saved local Codex session when releasing Web control", async () => {
    const localSessionId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    mocks.savedThreadIds.add(localSessionId);
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession(localSessionId);

    await provider.takeover();
    mocks.spawn.mockClear();

    await provider.releaseToLocal();

    expect(mocks.spawn).toHaveBeenCalledWith(
      "codex",
      ["resume", localSessionId],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
    expect(provider.state.owner).toBe("local");
    expect(provider.state.activeSessionId).toBe(localSessionId);
    expect(provider.state.resumeSessionId).toBe(localSessionId);

    provider.stop();
  });

  it("resumes a bound pending Web session when releasing Web control", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let threadStartCount = 0;
    const initialThreadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const slashThreadId = "019e2110-d96f-7e40-882e-b524fa9148e5";
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "adit/capabilities/discover") {
        throw appServerMethodsError();
      }
      if (method === "thread/start") {
        threadStartCount += 1;
        return {
          model: "gpt-test",
          thread: { id: threadStartCount === 1 ? initialThreadId : slashThreadId },
        };
      }
      if (method === "skills/list") return { data: [] };
      if (method === "mcpServerStatus/list") return { data: [] };
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    events.length = 0;

    await provider.handleSlashCommand({
      name: "new",
      args: [],
      raw: "/new",
      sessionId: "pending_web_session",
      pendingSessionId: "pending_web_session",
      localMessageId: "local-user-1",
    });

    expect(provider.state.activeSessionId).toBe(slashThreadId);
    expect(provider.state.resumeSessionId).toBe(slashThreadId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session-bound",
      payload: {
        pendingSessionId: "pending_web_session",
        sessionId: slashThreadId,
        createdAt: expect.any(Number),
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/new",
        sessionId: slashThreadId,
      }),
    }));

    mocks.savedThreadIds.add(slashThreadId);
    mocks.spawn.mockClear();

    await provider.releaseToLocal();

    expect(mocks.spawn).toHaveBeenCalledWith(
      "codex",
      ["resume", slashThreadId],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
    expect(provider.state.owner).toBe("local");
    expect(provider.state.activeSessionId).toBe(slashThreadId);
    expect(provider.state.resumeSessionId).toBe(slashThreadId);

    provider.stop();
  });

  it("starts a new Codex thread for an empty Web session request", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let threadStartCount = 0;
    const initialThreadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const newThreadId = "019e2110-d96f-7e40-882e-b524fa9148e6";
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "adit/capabilities/discover") {
        throw appServerMethodsError();
      }
      if (method === "thread/start") {
        threadStartCount += 1;
        return {
          model: "gpt-test",
          thread: { id: threadStartCount === 1 ? initialThreadId : newThreadId },
        };
      }
      if (method === "turn/interrupt") return {};
      if (method === "skills/list") return { data: [] };
      if (method === "mcpServerStatus/list") return { data: [] };
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    events.length = 0;

    await provider.startNewSession("pending_web_session");

    expect(threadStartCount).toBe(2);
    expect(provider.state.activeSessionId).toBe(newThreadId);
    expect(provider.state.resumeSessionId).toBe(newThreadId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session-bound",
      payload: {
        pendingSessionId: "pending_web_session",
        sessionId: newThreadId,
        createdAt: expect.any(Number),
      },
    }));

    provider.stop();
  });

  it("binds a pending Web session when /fork starts an empty thread", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let threadStartCount = 0;
    const initialThreadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const slashThreadId = "019e2110-d96f-7e40-882e-b524fa9148e5";
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "adit/capabilities/discover") {
        throw appServerMethodsError();
      }
      if (method === "thread/start") {
        threadStartCount += 1;
        return {
          model: "gpt-test",
          thread: { id: threadStartCount === 1 ? initialThreadId : slashThreadId },
        };
      }
      if (method === "skills/list") return { data: [] };
      if (method === "mcpServerStatus/list") return { data: [] };
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    events.length = 0;
    mocks.appRequest.mockClear();

    await provider.handleSlashCommand({
      name: "fork",
      args: [],
      raw: "/fork",
      sessionId: "pending_web_session",
      pendingSessionId: "pending_web_session",
      localMessageId: "local-user-1",
    });

    expect(provider.state.activeSessionId).toBe(slashThreadId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session-bound",
      payload: {
        pendingSessionId: "pending_web_session",
        sessionId: slashThreadId,
        createdAt: expect.any(Number),
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/fork",
        text: expect.stringContaining("no conversation to fork"),
        sessionId: slashThreadId,
      }),
    }));
    expect(mocks.appRequest.mock.calls.filter(([method]) => method === "thread/fork")).toHaveLength(0);

    provider.stop();
  });

  it("refreshes skills from app-server when /skills runs", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    await provider.takeover();
    mocks.appRequest.mockClear();
    mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "skills/list") {
        return {
          data: [
            {
              cwd: (params as { cwds?: string[] }).cwds?.[0] ?? "/tmp/project",
              skills: [
                {
                  name: "skill-installer",
                  description: "Install skills",
                  enabled: true,
                },
              ],
            },
          ],
        };
      }
      return {};
    });

    await provider.handleSlashCommand({ name: "skills", args: [], raw: "/skills" });

    expect(mocks.appRequest).toHaveBeenCalledWith("skills/list", {
      cwds: ["/tmp/project"],
      forceReload: false,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/skills",
        noticeKind: "skills",
        skills: [
          expect.objectContaining({
            name: "skill-installer",
            description: "Install skills",
          }),
        ],
      }),
    }));
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "skills", description: "List 1 Codex skill" });
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "skill-installer", description: "Use Codex skill: Install skills" });

    provider.stop();
  });

  it("refreshes MCP servers from app-server when /mcp runs", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    await provider.takeover();
    mocks.appRequest.mockClear();
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            { name: "chrome-devtools", tools: {}, authStatus: "unsupported" },
            { name: "codex_apps", tools: {}, authStatus: "bearerToken" },
          ],
        };
      }
      return {};
    });

    await provider.handleSlashCommand({ name: "mcp", args: [], raw: "/mcp" });

    expect(mocks.appRequest).toHaveBeenCalledWith("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/mcp",
        text: expect.stringContaining("codex_apps"),
      }),
    }));
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "mcp", description: "Show 2 Codex MCP servers" });
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "mcp.chrome-devtools", description: "Show Codex MCP server: chrome-devtools" });
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "mcp.codex_apps", description: "Show Codex MCP server: codex_apps" });

    provider.stop();
  });

  it("exposes individual skill slash commands that refresh skill data", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    await provider.takeover();
    mocks.appRequest.mockClear();

    await provider.handleSlashCommand({ name: "imagegen", args: [], raw: "/imagegen" });

    expect(mocks.appRequest).toHaveBeenCalledWith("skills/list", {
      cwds: ["/tmp/project"],
      forceReload: false,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/imagegen",
        noticeKind: "skills",
        skills: [
          expect.objectContaining({
            name: "imagegen",
            description: "Generate images",
          }),
        ],
      }),
    }));

    provider.stop();
  });

  it("exposes individual MCP server slash commands that refresh MCP data", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    await provider.takeover();
    mocks.appRequest.mockClear();

    await provider.handleSlashCommand({
      name: "mcp.chrome-devtools",
      args: [],
      raw: "/mcp.chrome-devtools",
    });

    expect(mocks.appRequest).toHaveBeenCalledWith("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/mcp.chrome-devtools",
        text: "- chrome-devtools: auth=unsupported, tools=2",
      }),
    }));

    provider.stop();
  });

  it("reports current branch and latest token usage while Web controls Codex", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    provider.noteModel("gpt-5.5");
    mocks.appServerOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        tokenUsage: {
          modelContextWindow: 258_400,
          last: {
            totalTokens: 126_215,
            inputTokens: 125_152,
            outputTokens: 1_063,
            reasoningOutputTokens: 516,
            cachedInputTokens: 124_288,
            cacheCreationInputTokens: 10,
          },
        },
      },
    });
    await tick();

    expect(provider.state.currentBranch).toBe("main");
    expect(provider.state.lastTokenUsage).toEqual(expect.objectContaining({
      totalTokens: 126_215,
      inputTokens: 125_152,
      outputTokens: 1_063,
      reasoningTokens: 516,
      cacheReadTokens: 124_288,
      cacheWriteTokens: 10,
      source: "codex-app-server",
    }));
    expect(provider.state.contextUsage).toEqual(expect.objectContaining({
      percentage: 46,
      totalTokens: 126_215,
      maxTokens: 258_400,
      modelId: "gpt-5.5",
      source: "codex-app-server",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "state",
      payload: expect.objectContaining({
        currentBranch: "main",
        contextUsage: expect.objectContaining({
          percentage: 46,
          totalTokens: 126_215,
          maxTokens: 258_400,
          modelId: "gpt-5.5",
        }),
        lastTokenUsage: expect.objectContaining({
          totalTokens: 126_215,
          inputTokens: 125_152,
          outputTokens: 1_063,
          reasoningTokens: 516,
          cacheReadTokens: 124_288,
          cacheWriteTokens: 10,
        }),
      }),
    }));

    (provider as unknown as { contextUsage: null }).contextUsage = null;
    provider.noteModel("gpt-5.5");
    expect(provider.state.contextUsage).toEqual(expect.objectContaining({
      percentage: 46,
      totalTokens: 126_215,
      maxTokens: 258_400,
      modelId: "gpt-5.5",
    }));

    provider.stop();
  });

  it("falls back to model context window when Codex omits runtime context window", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    provider.noteModel("gpt-5.5");
    mocks.appServerOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        tokenUsage: {
          last: {
            inputTokens: 1200,
            outputTokens: 300,
            reasoningOutputTokens: 50,
            cachedInputTokens: 200,
            cacheCreationInputTokens: 10,
          },
        },
      },
    });
    await tick();

    expect(provider.state.currentBranch).toBe("main");
    expect(provider.state.lastTokenUsage).toEqual(expect.objectContaining({
      inputTokens: 1200,
      outputTokens: 300,
      reasoningTokens: 50,
      cacheReadTokens: 200,
      cacheWriteTokens: 10,
      source: "codex-app-server",
    }));
    expect(provider.state.contextUsage).toEqual(expect.objectContaining({
      totalTokens: 1500,
      maxTokens: 1_050_000,
      modelId: "gpt-5.5",
      source: "codex-app-server",
    }));
    expect(provider.state.contextUsage?.percentage).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "state",
      payload: expect.objectContaining({
        currentBranch: "main",
        contextUsage: expect.objectContaining({
          totalTokens: 1500,
          maxTokens: 1_050_000,
          modelId: "gpt-5.5",
        }),
        lastTokenUsage: expect.objectContaining({
          inputTokens: 1200,
          outputTokens: 300,
          reasoningTokens: 50,
          cacheReadTokens: 200,
          cacheWriteTokens: 10,
        }),
      }),
    }));

    (provider as unknown as { contextUsage: null }).contextUsage = null;
    provider.noteModel("gpt-5.5");
    expect(provider.state.contextUsage).toEqual(expect.objectContaining({
      totalTokens: 1500,
      maxTokens: 1_050_000,
      modelId: "gpt-5.5",
    }));

    provider.stop();
  });

  it("preserves leading spaces in Codex app-server text deltas", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    mocks.appServerOptions?.onNotification?.({
      method: "item/agentMessage/delta",
      params: {
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        itemId: "item-1",
        delta: " Let's",
      },
    });
    mocks.appServerOptions?.onNotification?.({
      method: "item/agentMessage/delta",
      params: {
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        itemId: "item-1",
        delta: " analyze",
      },
    });
    await tick();

    expect(events.filter((event) => event.type === "assistant-delta").map((event) => event.payload.text))
      .toEqual([" Let's", " analyze"]);

    provider.stop();
  });

  it("keeps Codex context usage scoped to the selected thread", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();
    provider.noteModel("gpt-5.5");
    mocks.appServerOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        tokenUsage: {
          modelContextWindow: 258_400,
          last: {
            totalTokens: 1500,
            inputTokens: 1200,
            outputTokens: 300,
          },
        },
      },
    });
    await tick();
    expect(provider.state.contextUsage?.totalTokens).toBe(1500);
    expect(provider.state.contextUsage?.maxTokens).toBe(258_400);

    await provider.switchSession("019e0000-0000-7000-8000-000000000001");
    provider.noteModel("gpt-5.5");
    expect(provider.state.contextUsage).toBeNull();
    expect(provider.state.lastTokenUsage).toBeNull();

    mocks.appServerOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "019e0000-0000-7000-8000-000000000001",
        tokenUsage: {
          modelContextWindow: 258_400,
          last: {
            totalTokens: 2600,
            inputTokens: 2200,
            outputTokens: 400,
          },
        },
      },
    });
    await tick();
    expect(provider.state.contextUsage?.totalTokens).toBe(2600);

    await provider.switchSession("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(provider.state.contextUsage?.totalTokens).toBe(1500);
    expect(provider.state.contextUsage?.maxTokens).toBe(258_400);
    expect(provider.state.lastTokenUsage?.inputTokens).toBe(1200);

    provider.stop();
  });

  it("resumes the active thread when Web takes over an existing session", async () => {
    const child = mockChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession("019e2110-d96f-7e40-882e-b524fa9148e4");

    await provider.takeover();

    expect(mocks.appRequest).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        cwd: "/tmp/project",
        persistExtendedHistory: true,
      }),
    );
    expect(mocks.appRequest).not.toHaveBeenCalledWith(
      "thread/start",
      expect.anything(),
    );
    expect(provider.state.owner).toBe("web");
    expect(provider.state.activeSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");
    const resumeCallIndex = mocks.appRequest.mock.calls.findIndex(
      ([method]) => method === "thread/resume",
    );
    expect(resumeCallIndex).toBeGreaterThan(-1);
    expect(child.kill.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.appRequest.mock.invocationCallOrder[resumeCallIndex]!,
    );

    provider.stop();
  });

  it("retries takeover while the stopped local writer is still releasing", async () => {
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const child = mockChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    const defaultRequest = mocks.appRequest.getMockImplementation();
    let resumeAttempts = 0;
    mocks.appRequest.mockImplementation((method: string, params: unknown) => {
      if (method === "thread/resume") {
        resumeAttempts += 1;
        if (resumeAttempts === 1) {
          return Promise.reject(new Error(`thread ${threadId} already has an active writer`));
        }
      }
      return defaultRequest?.(method, params);
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession(threadId);

    await provider.takeover();

    expect(resumeAttempts).toBe(2);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(provider.state.owner).toBe("web");

    provider.stop();
  });

  it("resumes the session detected while takeover capabilities hydrate", async () => {
    const initialThreadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const latestThreadId = "019e2110-d96f-7e40-882e-b524fa9148e5";
    let resolveSkills: ((value: unknown) => void) | null = null;
    const defaultRequest = mocks.appRequest.getMockImplementation();
    mocks.appRequest.mockImplementation((method: string, params: unknown) => {
      if (method === "skills/list") {
        return new Promise((resolve) => {
          resolveSkills = resolve;
        });
      }
      return defaultRequest?.(method, params);
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession(initialThreadId);

    const takeover = provider.takeover();
    await tick();
    expect(resolveSkills).not.toBeNull();
    mocks.resumeWatcherOptions?.onResume(latestThreadId);
    resolveSkills?.({ data: [] });
    await takeover;

    expect(mocks.appRequest).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ threadId: latestThreadId }),
    );
    expect(mocks.appRequest).not.toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ threadId: initialThreadId }),
    );
    expect(provider.state.activeSessionId).toBe(latestThreadId);

    provider.stop();
  });

  it("keeps local control when Codex becomes busy during capability hydration", async () => {
    let resolveSkills: ((value: unknown) => void) | null = null;
    const defaultRequest = mocks.appRequest.getMockImplementation();
    mocks.appRequest.mockImplementation((method: string, params: unknown) => {
      if (method === "skills/list") {
        return new Promise((resolve) => {
          resolveSkills = resolve;
        });
      }
      return defaultRequest?.(method, params);
    });
    const child = mockChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    const takeover = expect(provider.takeover()).rejects.toMatchObject({
      message: "local Codex is busy",
      statusCode: 409,
    });
    await tick();
    expect(resolveSkills).not.toBeNull();
    provider.markLocalBusy();
    resolveSkills?.({ data: [] });
    await takeover;

    expect(child.kill).not.toHaveBeenCalled();
    expect(provider.state.owner).toBe("local");
    expect(mocks.appStop).toHaveBeenCalledTimes(1);

    provider.stop();
  });

  it("restores the local session when takeover cannot resume the thread", async () => {
    vi.useFakeTimers();
    const threadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const localChild = mockChildProcess();
    const restartedChild = mockChildProcess();
    mocks.spawn.mockReturnValueOnce(localChild).mockReturnValueOnce(restartedChild);
    const defaultRequest = mocks.appRequest.getMockImplementation();
    mocks.appRequest.mockImplementation((method: string, params: unknown) => {
      if (method === "thread/resume") {
        return Promise.reject(new Error(`thread ${threadId} already has an active writer`));
      }
      return defaultRequest?.(method, params);
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession(threadId);

    try {
      const takeover = expect(provider.takeover()).rejects.toThrow("already has an active writer");
      await vi.advanceTimersByTimeAsync(
        CODEX_LOCAL_WRITER_RELEASE_RETRY_DELAYS_MS.reduce(
          (sum, delayMs) => sum + delayMs,
          0,
        ),
      );
      await takeover;

      expect(localChild.kill).toHaveBeenCalled();
      expect(mocks.appStop).toHaveBeenCalledTimes(1);
      expect(mocks.spawn).toHaveBeenLastCalledWith(
        "codex",
        ["resume", threadId],
        expect.objectContaining({ cwd: "/tmp/project" }),
      );
      expect(provider.state.owner).toBe("local");
      expect(provider.state.activeSessionId).toBe(threadId);
    } finally {
      provider.stop();
      vi.useRealTimers();
    }
  });

  it("restores an empty local session when takeover cannot start a thread", async () => {
    const localChild = mockChildProcess();
    const restartedChild = mockChildProcess();
    mocks.spawn.mockReturnValueOnce(localChild).mockReturnValueOnce(restartedChild);
    const defaultRequest = mocks.appRequest.getMockImplementation();
    mocks.appRequest.mockImplementation((method: string, params: unknown) => {
      if (method === "thread/start") {
        return Promise.reject(new Error("thread start failed"));
      }
      return defaultRequest?.(method, params);
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    await expect(provider.takeover()).rejects.toThrow("thread start failed");

    expect(localChild.kill).toHaveBeenCalled();
    expect(mocks.appStop).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      "codex",
      [],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
    expect(provider.state.owner).toBe("local");
    expect(provider.state.activeSessionId).toBeNull();

    provider.stop();
  });

  it("unarchives an archived thread and retries the resume when switching sessions", async () => {
    const archivedThreadId = "019e0000-0000-7000-8000-00000000000a";
    let resumeAttempts = 0;
    let unarchived = false;
    mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "adit/capabilities/discover") throw appServerMethodsError();
      if (method === "thread/resume") {
        const threadId = (params as { threadId?: string }).threadId;
        if (threadId === archivedThreadId) {
          resumeAttempts += 1;
          if (!unarchived) {
            throw new Error(
              `session ${archivedThreadId} is archived. Run \`codex unarchive ${archivedThreadId}\` to restore it`,
            );
          }
        }
        return { model: "gpt-test", thread: { id: threadId } };
      }
      if (method === "thread/unarchive") {
        unarchived = true;
        return {};
      }
      if (method === "thread/start") {
        return { model: "gpt-test", thread: { id: "019e2110-d96f-7e40-882e-b524fa9148e4" } };
      }
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await provider.switchSession(archivedThreadId);

      expect(mocks.appRequest).toHaveBeenCalledWith(
        "thread/unarchive",
        { threadId: archivedThreadId },
      );
      expect(resumeAttempts).toBe(2);
      expect(provider.state.activeSessionId).toBe(archivedThreadId);
    } finally {
      provider.stop();
    }
  });

  it("does not attempt unarchive when the rollout is missing", async () => {
    const missingThreadId = "019e0000-0000-7000-8000-00000000000b";
    mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "adit/capabilities/discover") throw appServerMethodsError();
      if (method === "thread/resume") {
        const threadId = (params as { threadId?: string }).threadId;
        if (threadId === missingThreadId) {
          throw new Error(`no rollout found for thread id ${missingThreadId}`);
        }
        return { model: "gpt-test", thread: { id: threadId } };
      }
      if (method === "thread/start") {
        return { model: "gpt-test", thread: { id: "019e2110-d96f-7e40-882e-b524fa9148e4" } };
      }
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await expect(provider.switchSession(missingThreadId)).rejects.toThrow(
        `no rollout found for thread id ${missingThreadId}`,
      );
      expect(mocks.appRequest).not.toHaveBeenCalledWith(
        "thread/unarchive",
        expect.anything(),
      );
    } finally {
      provider.stop();
    }
  });

  it("does not resume a loaded empty thread when switching back to it", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();
    await provider.switchSession("019e0000-0000-7000-8000-000000000001");

    expect(mocks.appRequest).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        threadId: "019e0000-0000-7000-8000-000000000001",
      }),
    );

    mocks.appRequest.mockClear();
    await provider.switchSession("019e2110-d96f-7e40-882e-b524fa9148e4");

    expect(mocks.appRequest).not.toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      }),
    );
    expect(provider.state.activeSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");

    provider.stop();
  });

  it("sends prompt image attachments to app-server input", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    mocks.appRequest.mockClear();

    const attachment = {
      id: "att-1",
      kind: "image" as const,
      url: "https://storage.example.invalid/coding-attachments/u/2026/05/a.png",
      mimeType: "image/png",
      fileName: "a.png",
      sizeBytes: 1234,
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Buffer.from("png-bytes").buffer,
    })));

    await provider.sendPrompt("", { attachments: [attachment] });

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [
        {
          type: "image",
          url: expect.stringMatching(/^data:image\/png;base64,/),
          detail: "high",
        },
      ],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "message",
      payload: expect.objectContaining({
        role: "user",
        text: "",
        attachments: [attachment],
      }),
    }));

    provider.stop();
  });
});

describe("CodexCliProvider abort", () => {
  it("interrupts the active turn and emits a non-error abort event", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    await provider.abort();

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      turnId: "turn-1",
    });
    expect(events.some((event) => event.type === "run.aborted")).toBe(true);
    expect(events.some((event) =>
      event.type === "error" &&
      String(event.payload.message ?? "").includes("aborted")
    )).toBe(false);

    provider.stop();
  });

  it("interrupts the active turn and emits run.aborted before switching sessions", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    mocks.appRequest.mockClear();

    await provider.switchSession("019e0000-0000-7000-8000-000000000001");

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      turnId: "turn-1",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "run.aborted",
      payload: expect.objectContaining({
        message: "Codex session switched.",
        sessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      }),
    }));
    expect(provider.state.activeSessionId).toBe("019e0000-0000-7000-8000-000000000001");

    provider.stop();
  });

  it("emits run.aborted when releasing Web control during an active turn", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    mocks.appRequest.mockClear();

    await provider.releaseToLocal();

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      turnId: "turn-1",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "run.aborted",
      payload: expect.objectContaining({
        message: "Web control released to local CLI.",
        sessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      }),
    }));
    expect(provider.state.owner).toBe("local");

    provider.stop();
  });

  it("emits run.aborted when the provider stops during an active turn", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    mocks.appRequest.mockClear();

    provider.stop();

    expect(mocks.appRequest).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
    expect(events).toContainEqual(expect.objectContaining({
      type: "run.aborted",
      payload: expect.objectContaining({
        message: "Codex provider stopped.",
        sessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      }),
    }));
    expect(provider.state.owner).toBe("stopped");
  });
});

describe("CodexCliProvider steerPrompt", () => {
  it("sends steering input to the active turn without queuing a new prompt", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    mocks.appRequest.mockClear();

    await provider.steerPrompt("focus on tests", {
      sessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      localMessageId: "local-steer-1",
    });

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/steer", {
      threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      expectedTurnId: "turn-1",
      input: [
        {
          type: "text",
          text: "focus on tests",
          text_elements: [],
        },
      ],
    });
    expect(mocks.appRequest).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(events).toContainEqual(expect.objectContaining({
      type: "message",
      payload: expect.objectContaining({
        role: "user",
        sessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        messageId: "local-steer-1",
        text: "focus on tests",
        inputKind: "steer",
      }),
    }));

    provider.stop();
  });

  it("rejects steering when no turn is active", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();

    await expect(provider.steerPrompt("too early")).rejects.toThrow(
      "Codex is not currently accepting steering input",
    );

    provider.stop();
  });
});

describe("CodexCliProvider thread isolation", () => {
  it("ignores turn lifecycle notifications from a thread that is no longer active", async () => {
    const threadA = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const threadB = "019e2110-d96f-7e40-882e-b524fa9148e5";
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession(threadA);
    await provider.takeover();
    await provider.sendPrompt("first");
    expect(provider.state.busy).toBe(true);

    await provider.switchSession(threadB);
    expect(provider.state.busy).toBe(false);
    await provider.sendPrompt("second");
    expect(provider.state.busy).toBe(true);

    // A late completion from the abandoned thread must not clear the new run.
    mocks.appServerOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: threadA, turn: { id: "turn-stale", status: "completed" } },
    });
    expect(provider.state.busy).toBe(true);

    mocks.appServerOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: threadB, turn: { id: "turn-1", status: "completed" } },
    });
    expect(provider.state.busy).toBe(false);

    // A stale busy status must not resurrect activity either.
    mocks.appServerOptions?.onNotification?.({
      method: "thread/status/changed",
      params: { threadId: threadA, status: { type: "active" } },
    });
    expect(provider.state.busy).toBe(false);

    provider.stop();
  });

  it("rejects a queued prompt when the active session changed before it started", async () => {
    const threadA = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const threadB = "019e2110-d96f-7e40-882e-b524fa9148e5";
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    provider.noteLocalSession(threadA);
    await provider.takeover();
    await provider.sendPrompt("first");

    const second = provider.sendPrompt("second");
    const secondSettled = second.then(
      () => null,
      (error: Error) => error,
    );

    // The app-server announces a different thread (e.g. rebuilt externally),
    // then the running turn completes and the queue drains.
    mocks.appServerOptions?.onNotification?.({
      method: "thread/started",
      params: { thread: { id: threadB } },
    });
    mocks.appServerOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: threadB, turn: { id: "turn-1", status: "completed" } },
    });

    const error = await secondSettled;
    expect(error).toBeInstanceOf(Error);
    expect(String(error?.message)).toMatch(/session changed/i);
    const turnStarts = mocks.appRequest.mock.calls.filter(([method]) => method === "turn/start");
    expect(turnStarts).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      payload: expect.objectContaining({ sessionId: threadA }),
    }));

    provider.stop();
  });
});

describe("CodexCliProvider app-server errors", () => {
  const thread = "019e2110-d96f-7e40-882e-b524fa9148e4";

  function errorEvents(
    events: Array<{ type: string; payload: Record<string, unknown> }>,
  ): Array<Record<string, unknown>> {
    return events.filter((event) => event.type === "error").map((event) => event.payload);
  }

  it("reads flat and nested error notification text and stamps the session id", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    mocks.appServerOptions?.onNotification?.({
      method: "error",
      params: { threadId: thread, error: { message: "upstream 400" } },
    });
    mocks.appServerOptions?.onNotification?.({
      method: "error",
      params: { threadId: thread, message: "legacy shape" },
    });
    await tick();

    expect(errorEvents(events)).toEqual([
      expect.objectContaining({ message: "upstream 400", sessionId: thread }),
      expect.objectContaining({ message: "legacy shape", sessionId: thread }),
    ]);

    provider.stop();
  });

  it("emits a single card when the failed turn repeats the error notification", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");

    const message = "The 'gpt-5.6-sol' model requires a newer version of Codex.";
    mocks.appServerOptions?.onNotification?.({
      method: "error",
      params: { threadId: thread, turnId: "turn-1", error: { message } },
    });
    mocks.appServerOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: thread, turn: { id: "turn-1", status: "failed", error: { message } } },
    });
    await tick();

    expect(errorEvents(events)).toEqual([
      expect.objectContaining({ message, sessionId: thread }),
    ]);
    expect(provider.state.busy).toBe(false);

    provider.stop();
  });

  it("defers a message-less error notification to the turn failure", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");

    mocks.appServerOptions?.onNotification?.({ method: "error", params: {} });
    await tick();
    expect(errorEvents(events)).toHaveLength(0);

    mocks.appServerOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: thread, turn: { id: "turn-1", status: "failed", error: { message: "HTTP 400" } } },
    });
    await tick();

    expect(errorEvents(events)).toEqual([
      expect.objectContaining({ message: "HTTP 400", sessionId: thread }),
    ]);

    provider.stop();
  });

  it("still reports a message-less error notification when no turn is active", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    mocks.appServerOptions?.onNotification?.({ method: "error", params: {} });
    await tick();

    expect(errorEvents(events)).toEqual([
      expect.objectContaining({ message: "Codex app-server error" }),
    ]);

    provider.stop();
  });

  it("keeps both cards when the turn failure differs from the notification", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");

    mocks.appServerOptions?.onNotification?.({
      method: "error",
      params: { threadId: thread, turnId: "turn-1", error: { message: "stream disconnected" } },
    });
    mocks.appServerOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: thread, turn: { id: "turn-1", status: "failed", error: { message: "HTTP 400" } } },
    });
    await tick();

    expect(errorEvents(events)).toEqual([
      expect.objectContaining({ message: "stream disconnected", sessionId: thread }),
      expect.objectContaining({ message: "HTTP 400", sessionId: thread }),
    ]);

    provider.stop();
  });

  it("reports a turn failure that had no preceding error notification", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    mocks.appServerOptions?.onNotification?.({
      method: "turn/completed",
      params: { threadId: thread, turn: { id: "turn-1", status: "failed", error: { message: "boom" } } },
    });
    await tick();

    expect(errorEvents(events)).toEqual([
      expect.objectContaining({ message: "boom", sessionId: thread }),
    ]);

    provider.stop();
  });
});

describe("CodexCliProvider takeover notices", () => {
  function makeNoticeSink() {
    const output: string[] = [];
    const notices = createRelayNotices("codex", {
      write: (text) => void output.push(text),
      isTTY: () => false,
      debugEnabled: () => false,
      restoreTerminal: () => {},
    });
    return { output, notices };
  }

  it("announces the takeover before the slow app-server prep begins", async () => {
    const { output, notices } = makeNoticeSink();
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: () => {},
      notices,
    });

    await provider.takeover();

    const startedIndex = output.findIndex((line) => line.includes("Web is taking over this session"));
    const takenOverIndex = output.findIndex((line) => line.includes("Web has taken over this session"));
    expect(startedIndex).toBeGreaterThan(-1);
    expect(takenOverIndex).toBeGreaterThan(startedIndex);
    expect(provider.state.owner).toBe("web");

    provider.stop();
  });

  it("reports a failed takeover and keeps local control when prep fails", async () => {
    const { output, notices } = makeNoticeSink();
    const child = mockChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    mocks.appStart.mockRejectedValueOnce(new Error("app-server exploded"));
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: () => {},
      notices,
    });

    await expect(provider.takeover()).rejects.toThrow("app-server exploded");

    expect(output).toContainEqual(expect.stringContaining("Web is taking over this session"));
    expect(output).toContainEqual(expect.stringContaining("Web takeover failed"));
    expect(output).not.toContainEqual(expect.stringContaining("Web has taken over this session"));
    expect(provider.state.owner).toBe("local");
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.appStop).toHaveBeenCalledTimes(1);

    provider.stop();
  });
});
