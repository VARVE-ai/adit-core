import type {
  StartCollaborationConsultationInput,
  StartCollaborationConsultationResult,
} from "../types.js";

type EmitEvent = (type: string, payload: Record<string, unknown>) => void;

export interface ActiveCodexCollaboration {
  requestId: string;
  attemptId: string;
  runId: string;
  sessionId: string | null;
  providerRunId: string | null;
  finalMessageId: string | null;
  answer: string | null;
}

const CODEX_COLLABORATION_INSTRUCTION = [
  "You are answering a read-only consultation from another coding Agent.",
  "Inspect the current project and Session context as needed, but do not modify files or external state.",
  "Do not ask for permission to edit. Return a direct, evidence-based answer to the consultation question.",
].join("\n");

export function codexCollaborationPrompt(question: string): string {
  return `${CODEX_COLLABORATION_INSTRUCTION}\n\nConsultation question:\n${question}`;
}

export class CodexCollaborationRun {
  private value: ActiveCodexCollaboration | null = null;

  constructor(private readonly emitEvent: EmitEvent) {}

  get active(): ActiveCodexCollaboration | null {
    return this.value;
  }

  begin(input: StartCollaborationConsultationInput): void {
    this.value = {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runId: input.runId,
      sessionId: null,
      providerRunId: null,
      finalMessageId: null,
      answer: null,
    };
    this.emitEvent("collaboration.prepared", {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runId: input.runId,
      protocolVersion: "v1",
      mode: "consultation",
      sessionId: input.targetSessionId,
      guardrailReceipt: codexGuardrailReceipt("prepared"),
      createdAt: Date.now(),
    });
  }

  result(): StartCollaborationConsultationResult | null {
    const active = this.value;
    if (!active?.sessionId || !active.providerRunId) return null;
    return {
      sessionId: active.sessionId,
      providerRunId: active.providerRunId,
    };
  }

  markStarted(runId: string, sessionId: string, providerRunId: string | null): void {
    const active = this.value;
    if (!active || active.runId !== runId) return;
    active.sessionId = sessionId;
    active.providerRunId = providerRunId;
    this.emitEvent("collaboration.started", {
      requestId: active.requestId,
      attemptId: active.attemptId,
      runId: active.runId,
      protocolVersion: "v1",
      mode: "consultation",
      sessionId,
      providerRunId: providerRunId ?? undefined,
      guardrailReceipt: codexGuardrailReceipt("active"),
      createdAt: Date.now(),
    });
  }

  captureAnswer(input: {
    sessionId: string | null;
    messageId: string | null;
    text: string | null;
  }): void {
    const active = this.value;
    if (!active || (input.sessionId && active.sessionId !== input.sessionId)) return;
    active.answer = input.text;
    active.finalMessageId = input.messageId;
  }

  completeTurn(input: {
    status: string | null;
    sessionId: string | null;
    providerRunId: string | null;
    error: string | null;
  }): void {
    const active = this.value;
    if (
      !active
      || (input.sessionId && active.sessionId !== input.sessionId)
      || (input.providerRunId && active.providerRunId !== input.providerRunId)
    ) {
      return;
    }
    if (input.status === "completed" && active.answer?.trim()) {
      this.value = null;
      this.emitEvent("collaboration.completed", {
        requestId: active.requestId,
        attemptId: active.attemptId,
        runId: active.runId,
        protocolVersion: "v1",
        mode: "consultation",
        sessionId: active.sessionId ?? input.sessionId ?? undefined,
        providerRunId: active.providerRunId ?? input.providerRunId ?? undefined,
        finalMessageId: active.finalMessageId ?? undefined,
        answer: active.answer.trim(),
        answerComplete: true,
        createdAt: Date.now(),
      });
      return;
    }
    this.fail(
      input.error ?? "Codex consultation did not return an answer",
      input.sessionId,
      input.providerRunId,
    );
  }

  fail(
    message: string,
    sessionId: string | null,
    providerRunId: string | null,
    code = "EXECUTION_ABORTED",
  ): void {
    const active = this.value;
    if (!active) return;
    this.value = null;
    this.emitFailure({
      requestId: active.requestId,
      attemptId: active.attemptId,
      runId: active.runId,
      sessionId: active.sessionId ?? sessionId,
      providerRunId: active.providerRunId ?? providerRunId,
      message,
      code,
    });
  }

  assertAbortTarget(requestId: string, runId: string): ActiveCodexCollaboration | null {
    const active = this.value;
    if (active && (active.requestId !== requestId || active.runId !== runId)) {
      throw Object.assign(new Error("A different collaboration run is active"), {
        statusCode: 409,
      });
    }
    return active;
  }

  clear(): void {
    this.value = null;
  }

  emitAbort(input: {
    requestId: string;
    attemptId: string;
    runId: string;
    sessionId: string | null;
    providerRunId: string | null;
    message: string;
    code: string;
  }): void {
    this.emitFailure(input);
  }

  private emitFailure(input: {
    requestId: string;
    attemptId: string;
    runId: string;
    sessionId: string | null;
    providerRunId: string | null;
    message: string;
    code: string;
  }): void {
    this.emitEvent("collaboration.failed", {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runId: input.runId,
      protocolVersion: "v1",
      mode: "consultation",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.providerRunId ? { providerRunId: input.providerRunId } : {}),
      error: input.message,
      code: input.code,
      createdAt: Date.now(),
    });
  }
}

function codexGuardrailReceipt(stage: "prepared" | "active") {
  return {
    stage,
    policyVersion: "codex-consultation-read-only-v1",
    provider: "codex",
    promptMode: "plan",
    approvalPolicy: "never",
    externalToolsDenied: true,
    sandboxPolicy: {
      type: "readOnly",
      networkAccess: false,
    },
  };
}
