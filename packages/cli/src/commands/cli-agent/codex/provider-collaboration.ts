import { projectRuntimeDirectory, resolveLocalProject } from "@varveai/adit-core";
import type {
  AppendSessionContextInput,
  AppendSessionContextResult,
  StartCollaborationConsultationInput,
  StartCollaborationConsultationResult,
} from "../types.js";
import { ProviderSessionContext } from "../provider-session-context.js";
import type { SessionContextClaim } from "../session-context-store.js";
import {
  CodexCollaborationRun,
  codexCollaborationPrompt,
} from "./collaboration.js";
import {
  CodexSessionContextStore,
  formatCodexSessionContext,
} from "./session-context-store.js";

type EmitEvent = (type: string, payload: Record<string, unknown>) => void;

export interface CodexCollaborationPromptMarker {
  requestId: string;
  runId: string;
}

export class CodexProviderCollaboration {
  private readonly run: CodexCollaborationRun;
  private readonly context: ProviderSessionContext;

  constructor(input: {
    cwd: string;
    dataDir?: string;
    emitEvent: EmitEvent;
    debug: (message: string) => void;
  }) {
    this.run = new CodexCollaborationRun(input.emitEvent);
    this.context = new ProviderSessionContext(
      () => new CodexSessionContextStore(input.dataDir ?? projectRuntimeDirectory(resolveLocalProject({path:input.cwd}).projectId)),
      formatCodexSessionContext,
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

  commitContext(claim: SessionContextClaim | null, providerRunId: string | null): Promise<void> {
    return this.context.commit(claim, providerRunId);
  }

  releaseContext(claim: SessionContextClaim | null): Promise<void> {
    return this.context.release(claim);
  }

  modelPrompt(message: string, marker: CodexCollaborationPromptMarker | null): string {
    return marker ? codexCollaborationPrompt(message) : message;
  }

  async start(
    input: StartCollaborationConsultationInput,
    enqueue: (question: string, marker: CodexCollaborationPromptMarker) => Promise<void>,
    currentRun: () => { sessionId: string | null; providerRunId: string | null },
  ): Promise<StartCollaborationConsultationResult> {
    const question = input.question.trim();
    if (!question) throw new Error("Collaboration question is required");
    this.run.begin(input);
    try {
      await enqueue(question, { requestId: input.requestId, runId: input.runId });
    } catch (error) {
      const current = currentRun();
      this.run.fail(errorMessage(error), current.sessionId, current.providerRunId);
      throw error;
    }
    const result = this.run.result();
    if (!result) throw new Error("Codex did not return collaboration run identifiers");
    return result;
  }

  markStarted(runId: string, sessionId: string, providerRunId: string | null): void {
    this.run.markStarted(runId, sessionId, providerRunId);
  }

  captureAnswer(input: { sessionId: string | null; messageId: string | null; text: string | null }): void {
    this.run.captureAnswer(input);
  }

  completeTurn(input: {
    status: string | null;
    sessionId: string | null;
    providerRunId: string | null;
    error: string | null;
  }): void {
    this.run.completeTurn(input);
  }

  fail(message: string, sessionId: string | null, providerRunId: string | null, code?: string): void {
    this.run.fail(message, sessionId, providerRunId, code);
  }

  assertAbortTarget(requestId: string, runId: string) {
    return this.run.assertAbortTarget(requestId, runId);
  }

  clear(): void {
    this.run.clear();
  }

  emitAbort(input: Parameters<CodexCollaborationRun["emitAbort"]>[0]): void {
    this.run.emitAbort(input);
  }

  close(): void {
    this.context.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
