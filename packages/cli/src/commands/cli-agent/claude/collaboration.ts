import type {
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  StartCollaborationConsultationInput,
  StartCollaborationConsultationResult,
} from "../types.js";
import { asRecord, readString } from "./sdk-messages.js";

type EmitEvent = (type: string, payload: Record<string, unknown>) => void;

export interface ActiveClaudeCollaboration {
  requestId: string;
  attemptId: string;
  runId: string;
  sessionId: string;
  providerRunId: string;
  finalMessageId: string | null;
  answer: string | null;
}

const CLAUDE_COLLABORATION_INSTRUCTION = [
  "You are answering a read-only consultation from another coding Agent.",
  "Inspect the current project and Session context as needed, but do not modify files or external state.",
  "Use only read-only workspace inspection tools. Do not run shell commands, ask questions, or request permission.",
  "Return a direct, evidence-based answer to the consultation question.",
].join("\n");

const CLAUDE_COLLABORATION_READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

export function claudeCollaborationPrompt(question: string): string {
  return `${CLAUDE_COLLABORATION_INSTRUCTION}\n\nConsultation question:\n${question}`;
}

export function handleClaudeCollaborationToolPermission(
  toolName: string,
  input: unknown,
  id: string,
): Promise<PermissionResult> {
  if (CLAUDE_COLLABORATION_READ_ONLY_TOOLS.has(toolName)) {
    return Promise.resolve({
      behavior: "allow",
      updatedInput: asRecord(input) ?? {},
      toolUseID: id,
    });
  }
  return Promise.resolve({
    behavior: "deny",
    message: "This collaboration is read-only and does not permit this tool.",
    toolUseID: id,
  });
}

export class ClaudeCollaborationRun {
  private value: ActiveClaudeCollaboration | null = null;

  constructor(private readonly emitEvent: EmitEvent) {}

  get active(): ActiveClaudeCollaboration | null {
    return this.value;
  }

  begin(
    input: StartCollaborationConsultationInput,
    sessionId: string,
    providerRunId: string,
  ): StartCollaborationConsultationResult {
    this.value = {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runId: input.runId,
      sessionId,
      providerRunId,
      finalMessageId: null,
      answer: null,
    };
    this.emitEvent("collaboration.prepared", {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runId: input.runId,
      protocolVersion: "v1",
      mode: "consultation",
      sessionId,
      guardrailReceipt: claudeGuardrailReceipt("prepared"),
      createdAt: Date.now(),
    });
    return { sessionId, providerRunId };
  }

  markStarted(runId: string): void {
    const active = this.value;
    if (!active || active.runId !== runId) return;
    this.emitEvent("collaboration.started", {
      requestId: active.requestId,
      attemptId: active.attemptId,
      runId: active.runId,
      protocolVersion: "v1",
      mode: "consultation",
      sessionId: active.sessionId,
      providerRunId: active.providerRunId,
      guardrailReceipt: claudeGuardrailReceipt("active"),
      createdAt: Date.now(),
    });
  }

  captureAssistant(message: SDKAssistantMessage, sessionId: string): void {
    const active = this.value;
    if (!active || active.sessionId !== sessionId) return;
    const reply = collaborationAssistantReply(message);
    if (!reply) return;
    active.answer = reply.text;
    active.finalMessageId = reply.messageId;
  }

  complete(message: SDKMessage, sessionId: string): void {
    const active = this.value;
    if (!active || active.sessionId !== sessionId) return;
    if (claudeResultSucceeded(message) && active.answer?.trim()) {
      this.value = null;
      this.emitEvent("collaboration.completed", {
        requestId: active.requestId,
        attemptId: active.attemptId,
        runId: active.runId,
        protocolVersion: "v1",
        mode: "consultation",
        sessionId: active.sessionId,
        providerRunId: active.providerRunId,
        finalMessageId: active.finalMessageId ?? undefined,
        answer: active.answer.trim(),
        answerComplete: true,
        createdAt: Date.now(),
      });
      return;
    }
    this.fail(
      claudeResultSucceeded(message)
        ? "Claude consultation did not return an answer"
        : "Claude consultation failed",
      "EXECUTION_ABORTED",
    );
  }

  fail(message: string, code: string): void {
    const active = this.value;
    if (!active) return;
    this.value = null;
    this.emitFailure({
      requestId: active.requestId,
      attemptId: active.attemptId,
      runId: active.runId,
      sessionId: active.sessionId,
      providerRunId: active.providerRunId,
      message,
      code,
    });
  }

  assertAbortTarget(requestId: string, runId: string): ActiveClaudeCollaboration | null {
    const active = this.value;
    if (active && (active.requestId !== requestId || active.runId !== runId)) {
      throw Object.assign(new Error("A different collaboration run is active"), {
        statusCode: 409,
      });
    }
    return active;
  }

  emitAbort(input: {
    requestId: string;
    attemptId: string;
    runId: string;
    message: string;
    code: string;
  }): void {
    this.emitFailure({
      ...input,
      sessionId: null,
      providerRunId: null,
    });
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

function claudeGuardrailReceipt(stage: "prepared" | "active") {
  return {
    stage,
    policyVersion: "claude-consultation-read-only-v1",
    provider: "claude-code",
    permissionMode: "plan",
    allowedTools: [...CLAUDE_COLLABORATION_READ_ONLY_TOOLS],
    denyByDefault: true,
  };
}

function collaborationAssistantReply(
  message: SDKAssistantMessage,
): { messageId: string | null; text: string } | null {
  if (readString((message as { parent_tool_use_id?: unknown }).parent_tool_use_id)) return null;
  const content = message.message?.content;
  if (!Array.isArray(content)) return null;
  const text = (content as unknown as Array<Record<string, unknown>>)
    .flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : [])
    .join("\n")
    .trim();
  if (!text) return null;
  return {
    messageId: readString((message.message as { id?: unknown }).id),
    text,
  };
}

function claudeResultSucceeded(message: SDKMessage): boolean {
  const result = message as { subtype?: unknown; is_error?: unknown };
  const subtype = readString(result.subtype);
  return result.is_error !== true && !subtype?.startsWith("error_");
}
