import { EventEmitter } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAbortError extends Error {}
  return {
    AbortError: MockAbortError,
    query: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  AbortError: mocks.AbortError,
  query: (...args: unknown[]) => mocks.query(...args),
}));

vi.mock("@varveai/adit-engine", () => ({
  getCurrentBranch: vi.fn(async () => "main"),
}));

import { ClaudeCodeProvider } from "./provider.js";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const tempDirs: string[] = [];

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

function capabilityQuery() {
  return {
    supportedCommands: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    close: vi.fn(),
    interrupt: vi.fn(),
    async *[Symbol.asyncIterator]() {},
  };
}

function dataDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "adit-claude-collaboration-"));
  tempDirs.push(dir);
  return dir;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function userText(message: Record<string, unknown>): string {
  const body = message.message as { content?: unknown };
  return typeof body.content === "string" ? body.content : JSON.stringify(body.content);
}

function createProvider(input: {
  dir: string;
  events?: Array<{ type: string; payload: Record<string, unknown> }>;
}) {
  const provider = new ClaudeCodeProvider({
    bin: "claude",
    args: [],
    cwd: input.dir,
    dataDir: input.dir,
    onEvent: (event) => input.events?.push(event),
  });
  provider.noteLocalSession(SESSION_A);
  return provider;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockImplementation(() => mockChildProcess());
  mocks.query.mockImplementation(() => capabilityQuery());
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Claude collaboration context", () => {
  it("persists context without invoking Claude and rejects changed duplicate IDs", async () => {
    const dir = dataDir();
    const provider = createProvider({ dir });
    try {
      const input = {
        sessionId: SESSION_A,
        contextEntryId: "33333333-3333-4333-8333-333333333333",
        requestId: "44444444-4444-4444-8444-444444444444",
        kind: "collaboration_request" as const,
        content: "Please inspect the cache invalidation path.",
      };

      await expect(provider.appendSessionContext(input)).resolves.toEqual(expect.objectContaining({
        provider: "claude-code",
        appended: true,
        persisted: true,
      }));
      expect(mocks.query.mock.calls.filter(([call]) =>
        (call as { options?: { includePartialMessages?: boolean } }).options?.includePartialMessages === true
      )).toHaveLength(0);
      await expect(provider.appendSessionContext(input)).resolves.toEqual(expect.objectContaining({
        appended: false,
      }));
      await expect(provider.appendSessionContext({
        ...input,
        content: "Changed content",
      })).rejects.toThrow("already used");
    } finally {
      provider.stop();
    }
  });

  it("injects only pending context for the exact Session and marks it applied", async () => {
    const dir = dataDir();
    const prompts: string[] = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    mocks.query.mockImplementation((input: {
      prompt?: AsyncIterable<Record<string, unknown>>;
      options?: { includePartialMessages?: boolean };
    }) => {
      if (!input.options?.includePartialMessages) return capabilityQuery();
      return {
        ...capabilityQuery(),
        getContextUsage: vi.fn(async () => null),
        async *[Symbol.asyncIterator]() {
          const next = await input.prompt?.[Symbol.asyncIterator]().next();
          if (next?.value) prompts.push(userText(next.value));
          yield {
            type: "assistant",
            session_id: SESSION_A,
            message: {
              id: "assistant-1",
              role: "assistant",
              model: "claude-test",
              content: [{ type: "text", text: "done" }],
            },
          };
          yield { type: "result", subtype: "success", session_id: SESSION_A };
        },
      };
    });
    const provider = createProvider({ dir, events });
    try {
      await provider.appendSessionContext({
        sessionId: SESSION_A,
        contextEntryId: "33333333-3333-4333-8333-333333333333",
        requestId: "44444444-4444-4444-8444-444444444444",
        kind: "collaboration_request",
        content: "Context for A",
      });
      await provider.appendSessionContext({
        sessionId: SESSION_B,
        contextEntryId: "55555555-5555-4555-8555-555555555555",
        requestId: "66666666-6666-4666-8666-666666666666",
        kind: "collaboration_result",
        content: "Context for B",
      });
      await provider.takeover();
      await provider.sendPrompt("normal prompt");
      await tick();
      await tick();
      await provider.sendPrompt("second prompt");
      await tick();
      await tick();

      expect(prompts[0]).toContain("Context for A");
      expect(prompts[0]).not.toContain("Context for B");
      expect(prompts[0]).toContain("normal prompt");
      expect(prompts[1]).toBe("second prompt");
      expect(events.filter((event) => event.type === "context.applied")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            contextEntryId: "33333333-3333-4333-8333-333333333333",
            requestId: "44444444-4444-4444-8444-444444444444",
            sessionId: SESSION_A,
          }),
        }),
      ]);
    } finally {
      provider.stop();
    }
  });
});

describe("Claude read-only collaboration", () => {
  it("uses Plan mode, enforces the read-only tool allowlist, and emits scoped completion", async () => {
    const dir = dataDir();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const prompts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let remoteInput: {
      prompt?: AsyncIterable<Record<string, unknown>>;
      options?: Record<string, unknown>;
    } | null = null;
    mocks.query.mockImplementation((input: typeof remoteInput) => {
      if (!(input?.options as { includePartialMessages?: boolean })?.includePartialMessages) {
        return capabilityQuery();
      }
      remoteInput = input;
      return {
        ...capabilityQuery(),
        getContextUsage: vi.fn(async () => null),
        async *[Symbol.asyncIterator]() {
          const next = await input?.prompt?.[Symbol.asyncIterator]().next();
          if (next?.value) prompts.push(userText(next.value));
          await gate;
          yield {
            type: "assistant",
            session_id: SESSION_A,
            message: {
              id: "consultation-answer",
              role: "assistant",
              model: "claude-test",
              content: [{ type: "text", text: "The cache is invalidated in cache.ts:42." }],
            },
          };
          yield { type: "result", subtype: "success", session_id: SESSION_A };
        },
      };
    });
    const provider = createProvider({ dir, events });
    try {
      await provider.appendSessionContext({
        sessionId: SESSION_A,
        contextEntryId: "33333333-3333-4333-8333-333333333333",
        requestId: "44444444-4444-4444-8444-444444444444",
        kind: "collaboration_result",
        content: "Pending context for the next normal prompt.",
      });
      await provider.takeover();
      const result = await provider.startCollaborationConsultation({
        requestId: "44444444-4444-4444-8444-444444444444",
        attemptId: "66666666-6666-4666-8666-666666666666",
        runId: "55555555-5555-4555-8555-555555555555",
        protocolVersion: "v1",
        mode: "consultation",
        targetSessionId: SESSION_A,
        question: "Where is the cache invalidated?",
      });
      const options = remoteInput?.options as {
        permissionMode?: string;
        allowDangerouslySkipPermissions?: boolean;
        canUseTool?: (toolName: string, input: unknown, opts: { toolUseID: string }) => Promise<unknown>;
      };
      expect(result).toEqual({ sessionId: SESSION_A, providerRunId: expect.any(String) });
      expect(options.permissionMode).toBe("plan");
      expect(options.allowDangerouslySkipPermissions).toBeUndefined();
      await expect(options.canUseTool?.("Read", { file_path: "cache.ts" }, { toolUseID: "read" }))
        .resolves.toEqual(expect.objectContaining({ behavior: "allow" }));
      for (const toolName of ["Edit", "Write", "Bash", "AskUserQuestion", "ExitPlanMode", "TodoWrite", "mcp__custom"]) {
        await expect(options.canUseTool?.(toolName, {}, { toolUseID: toolName }))
          .resolves.toEqual(expect.objectContaining({ behavior: "deny" }));
      }
      expect(events).toContainEqual(expect.objectContaining({
        type: "collaboration.prepared",
        payload: expect.objectContaining({
          sessionId: SESSION_A,
          guardrailReceipt: expect.objectContaining({ stage: "prepared" }),
        }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "collaboration.started",
        payload: expect.objectContaining({
          attemptId: "66666666-6666-4666-8666-666666666666",
          providerRunId: result.providerRunId,
          protocolVersion: "v1",
          mode: "consultation",
          guardrailReceipt: expect.objectContaining({
            stage: "active",
            policyVersion: "claude-consultation-read-only-v1",
            permissionMode: "plan",
            denyByDefault: true,
          }),
        }),
      }));
      expect(events.some((event) => event.type === "permission")).toBe(false);
      expect(prompts[0]).not.toContain("Pending context for the next normal prompt.");
      expect(events.some((event) => event.type === "context.applied")).toBe(false);

      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(events).toContainEqual(expect.objectContaining({
        type: "collaboration.completed",
        payload: expect.objectContaining({
          providerRunId: result.providerRunId,
          finalMessageId: "consultation-answer",
          answer: "The cache is invalidated in cache.ts:42.",
          answerComplete: true,
        }),
      }));

      await provider.sendPrompt("Continue with the normal task.");
      await tick();
      await tick();
      expect(prompts[1]).toContain("Pending context for the next normal prompt.");
      expect(events.some((event) => event.type === "context.applied")).toBe(true);
    } finally {
      release();
      provider.stop();
    }
  });

  it("aborts only the matching collaboration and emits its terminal failure", async () => {
    const dir = dataDir();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    mocks.query.mockImplementation((input: {
      options?: { includePartialMessages?: boolean; abortController?: AbortController };
    }) => {
      if (!input.options?.includePartialMessages) return capabilityQuery();
      return {
        ...capabilityQuery(),
        getContextUsage: vi.fn(async () => null),
        interrupt: vi.fn(async () => input.options?.abortController?.abort()),
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve, reject) => {
            const signal = input.options?.abortController?.signal;
            signal?.addEventListener("abort", () => reject(new mocks.AbortError("aborted")), { once: true });
          });
        },
      };
    });
    const provider = createProvider({ dir, events });
    try {
      await provider.takeover();
      await provider.startCollaborationConsultation({
        requestId: "44444444-4444-4444-8444-444444444444",
        attemptId: "66666666-6666-4666-8666-666666666666",
        runId: "55555555-5555-4555-8555-555555555555",
        protocolVersion: "v1",
        mode: "consultation",
        targetSessionId: SESSION_A,
        question: "Inspect this project",
      });
      await expect(provider.abortCollaborationConsultation({
        requestId: "77777777-7777-4777-8777-777777777777",
        attemptId: "99999999-9999-4999-8999-999999999999",
        runId: "88888888-8888-4888-8888-888888888888",
        code: "EXECUTION_ABORTED",
        message: "wrong run",
      })).rejects.toMatchObject({ statusCode: 409 });
      await provider.abortCollaborationConsultation({
        requestId: "44444444-4444-4444-8444-444444444444",
        attemptId: "66666666-6666-4666-8666-666666666666",
        runId: "55555555-5555-4555-8555-555555555555",
        code: "RUN_TIMEOUT",
        message: "Collaboration timed out",
      });
      expect(events.filter((event) => event.type === "collaboration.failed")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            code: "RUN_TIMEOUT",
            error: "Collaboration timed out",
          }),
        }),
      ]);
    } finally {
      provider.stop();
    }
  });

  it("emits a collaboration failure when the Claude stream throws", async () => {
    const dir = dataDir();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    mocks.query.mockImplementation((input: {
      options?: { includePartialMessages?: boolean };
    }) => {
      if (!input.options?.includePartialMessages) return capabilityQuery();
      return {
        ...capabilityQuery(),
        getContextUsage: vi.fn(async () => null),
        async *[Symbol.asyncIterator]() {
          throw new Error("upstream disconnected");
        },
      };
    });
    const provider = createProvider({ dir, events });
    try {
      await provider.takeover();
      await provider.startCollaborationConsultation({
        requestId: "44444444-4444-4444-8444-444444444444",
        attemptId: "66666666-6666-4666-8666-666666666666",
        runId: "55555555-5555-4555-8555-555555555555",
        protocolVersion: "v1",
        mode: "consultation",
        targetSessionId: SESSION_A,
        question: "Inspect this project",
      });
      await tick();
      await tick();
      expect(events).toContainEqual(expect.objectContaining({
        type: "collaboration.failed",
        payload: expect.objectContaining({
          error: "upstream disconnected",
          code: "EXECUTION_ABORTED",
        }),
      }));
    } finally {
      provider.stop();
    }
  });
});
