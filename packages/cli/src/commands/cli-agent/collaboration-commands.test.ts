import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import {
  isCollaborationLifecycleEvent,
  processCollaborationCommand,
  removeQueuedCollaborationPrompts,
} from "./collaboration-commands.js";
import type { CliAgentProvider, RelayCommand } from "./types.js";

describe("collaboration command handling", () => {
  it("routes persisted context without changing its metadata", async () => {
    const appendSessionContext = vi.fn(async () => ({
      provider: "codex" as const,
      sessionId: "session-1",
      contextEntryId: "context-1",
      persisted: true as const,
      appended: true,
    }));
    const handled = await processCollaborationCommand({
      provider: createProvider({ appendSessionContext }),
      providerName: "Codex",
      command: command("append-session-context", {
        sessionId: " session-1 ",
        contextEntryId: " context-1 ",
        requestId: " request-1 ",
        kind: "collaboration_request",
        content: " question ",
        metadata: { source: "panel-a" },
      }),
    });

    assert.equal(handled, true);
    assert.deepEqual(appendSessionContext.mock.calls[0]?.[0], {
      sessionId: "session-1",
      contextEntryId: "context-1",
      requestId: "request-1",
      kind: "collaboration_request",
      content: "question",
      metadata: { source: "panel-a" },
    });
  });

  it("routes consultation start and scoped abort commands", async () => {
    const startCollaborationConsultation = vi.fn(async () => ({
      sessionId: "session-2",
      providerRunId: "provider-run-1",
    }));
    const abortCollaborationConsultation = vi.fn(async () => undefined);
    const provider = createProvider({
      startCollaborationConsultation,
      abortCollaborationConsultation,
    });

    assert.equal(await processCollaborationCommand({
      provider,
      providerName: "Claude",
      command: command("collaboration-prompt", {
        requestId: "request-2",
        attemptId: "attempt-2",
        runId: "run-2",
        protocolVersion: "v1",
        mode: "consultation",
        targetSessionId: "session-2",
        question: " inspect this ",
      }),
    }), true);
    assert.deepEqual(startCollaborationConsultation.mock.calls[0]?.[0], {
      requestId: "request-2",
      attemptId: "attempt-2",
      runId: "run-2",
      protocolVersion: "v1",
      mode: "consultation",
      targetSessionId: "session-2",
      question: "inspect this",
    });

    assert.equal(await processCollaborationCommand({
      provider,
      providerName: "Claude",
      command: command("abort", {
        collaborationRequestId: "request-2",
        collaborationAttemptId: "attempt-2",
        collaborationRunId: "run-2",
        collaborationErrorCode: "RUN_TIMEOUT",
        collaborationErrorMessage: "timed out",
      }),
    }), true);
    assert.deepEqual(abortCollaborationConsultation.mock.calls[0]?.[0], {
      requestId: "request-2",
      attemptId: "attempt-2",
      runId: "run-2",
      code: "RUN_TIMEOUT",
      message: "timed out",
    });
  });

  it("leaves ordinary commands for the provider-specific command handler", async () => {
    const provider = createProvider();
    assert.equal(await processCollaborationCommand({
      provider,
      providerName: "Codex",
      command: command("prompt", { text: "keep the normal path" }),
    }), false);
    assert.equal(await processCollaborationCommand({
      provider,
      providerName: "Codex",
      command: command("abort", {}),
    }), false);
    assert.equal(vi.mocked(provider.abort).mock.calls.length, 0);
    assert.equal(vi.mocked(provider.sendPrompt).mock.calls.length, 0);
  });

  it("removes only queued collaboration prompts after disconnect", () => {
    const queue = [
      command("prompt", { text: "one" }),
      command("collaboration-prompt", { question: "two" }),
      command("append-session-context", { content: "three" }),
      command("collaboration-prompt", { question: "four" }),
    ];
    removeQueuedCollaborationPrompts(queue);
    assert.deepEqual(queue.map((item) => item.type), ["prompt", "append-session-context"]);
  });

  it("marks only collaboration lifecycle events for reliable delivery", () => {
    assert.equal(isCollaborationLifecycleEvent({
      type: "collaboration.completed",
      payload: {},
    }), true);
    assert.equal(isCollaborationLifecycleEvent({
      type: "context.applied",
      payload: {},
    }), true);
    assert.equal(isCollaborationLifecycleEvent({ type: "message", payload: {} }), false);
  });
});

function command(type: RelayCommand["type"], payload: Record<string, unknown>): RelayCommand {
  return {
    id: `${type}-${Math.random()}`,
    type,
    payload,
    createdAt: Date.now(),
  };
}

function createProvider(
  overrides: Partial<CliAgentProvider> = {},
): CliAgentProvider {
  return {
    provider: "codex",
    state: {
      owner: "web",
      busy: false,
      thinking: false,
      activeSessionId: "session-1",
      resumeSessionId: "session-1",
      sdkSessionId: "session-1",
      activeModelId: null,
      currentBranch: null,
      contextUsage: null,
      lastTokenUsage: null,
    },
    permissions: [],
    takeover: vi.fn(async () => undefined),
    releaseToLocal: vi.fn(async () => undefined),
    switchSession: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => undefined),
    handleSlashCommand: vi.fn(async () => undefined),
    answerPermission: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    stop: vi.fn(),
    ...overrides,
  };
}
