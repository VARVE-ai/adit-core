import { projectRuntimeDirectory, resolveLocalProject } from "@varveai/adit-core";
import type { PermissionResult, SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AppendSessionContextInput,
  AppendSessionContextResult,
  StartCollaborationConsultationInput,
  StartCollaborationConsultationResult,
} from "../types.js";
import { ProviderSessionContext } from "../provider-session-context.js";
import type { SessionContextClaim } from "../session-context-store.js";
import {
  ClaudeCollaborationRun,
  claudeCollaborationPrompt,
  handleClaudeCollaborationToolPermission,
} from "./collaboration.js";
import {
  ClaudeSessionContextStore,
  formatClaudeSessionContext,
} from "./session-context-store.js";

type EmitEvent = (type: string, payload: Record<string, unknown>) => void;

export interface ClaudeCollaborationPromptMarker {
  requestId: string;
  runId: string;
}

export class ClaudeProviderCollaboration {
  private readonly run: ClaudeCollaborationRun;
  private readonly context: ProviderSessionContext;

  constructor(input: {
    cwd: string;
    dataDir?: string;
    emitEvent: EmitEvent;
    debug: (message: string) => void;
  }) {
    this.run = new ClaudeCollaborationRun(input.emitEvent);
    this.context = new ProviderSessionContext(
      () => new ClaudeSessionContextStore(input.dataDir ?? projectRuntimeDirectory(resolveLocalProject({path:input.cwd}).projectId)),
      formatClaudeSessionContext,
      input.emitEvent,
      input.debug,
    );
  }

  get active() {
    return this.run.active;
  }

  appendContext(input: AppendSessionContextInput): Promise<AppendSessionContextResult> {
    return this.context.append(input);
  }

  claimContext(sessionId: string, required: boolean) {
    return this.context.claim(sessionId, required);
  }

  commitContext(claim: SessionContextClaim | null): Promise<void> {
    return this.context.commit(claim);
  }

  releaseContext(claim: SessionContextClaim | null): Promise<void> {
    return this.context.release(claim);
  }

  modelPrompt(message: string, marker: ClaudeCollaborationPromptMarker | null): string {
    return marker ? claudeCollaborationPrompt(message) : message;
  }

  toolPermission(toolName: string, input: unknown, toolUseId: string): Promise<PermissionResult> {
    return handleClaudeCollaborationToolPermission(toolName, input, toolUseId);
  }

  async start(
    input: StartCollaborationConsultationInput,
    sessionId: string,
    providerRunId: string,
    enqueue: (question: string, marker: ClaudeCollaborationPromptMarker) => Promise<void>,
  ): Promise<StartCollaborationConsultationResult> {
    const question = input.question.trim();
    if (!question) throw new Error("Collaboration question is required");
    const result = this.run.begin(input, sessionId, providerRunId);
    try {
      await enqueue(question, { requestId: input.requestId, runId: input.runId });
    } catch (error) {
      this.run.fail(errorMessage(error), "EXECUTION_ABORTED");
      throw error;
    }
    return result;
  }

  markStarted(runId: string): void {
    this.run.markStarted(runId);
  }

  failQueued(marker: ClaudeCollaborationPromptMarker | null, error: unknown): void {
    if (!marker || this.run.active?.runId !== marker.runId) return;
    this.run.fail(errorMessage(error), "EXECUTION_ABORTED");
  }

  captureAssistant(message: SDKAssistantMessage, sessionId: string): void {
    this.run.captureAssistant(message, sessionId);
  }

  complete(message: SDKMessage, sessionId: string): void {
    this.run.complete(message, sessionId);
  }

  fail(message: string, code: string): void {
    this.run.fail(message, code);
  }

  assertAbortTarget(requestId: string, runId: string) {
    return this.run.assertAbortTarget(requestId, runId);
  }

  emitAbort(input: Parameters<ClaudeCollaborationRun["emitAbort"]>[0]): void {
    this.run.emitAbort(input);
  }

  close(): void {
    this.context.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
