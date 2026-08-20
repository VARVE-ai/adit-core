import type {
  AppendSessionContextInput,
  CliAgentProvider,
  CliAgentRelayEvent,
  RelayCommand,
} from "./types.js";

export function isCollaborationLifecycleEvent(event: CliAgentRelayEvent): boolean {
  return event.type === "collaboration.prepared"
    || event.type === "collaboration.started"
    || event.type === "collaboration.completed"
    || event.type === "collaboration.failed"
    || event.type === "context.applied";
}

export function removeQueuedCollaborationPrompts(queue: RelayCommand[]): void {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index]?.type === "collaboration-prompt") queue.splice(index, 1);
  }
}

export async function processCollaborationCommand(input: {
  provider: CliAgentProvider;
  providerName: "Claude" | "Codex";
  command: RelayCommand;
}): Promise<boolean> {
  const { provider, providerName, command } = input;

  if (command.type === "append-session-context") {
    const sessionId = readString(command.payload.sessionId);
    const contextEntryId = readString(command.payload.contextEntryId);
    const requestId = readString(command.payload.requestId);
    const content = readString(command.payload.content);
    const kind = readString(command.payload.kind);
    if (!sessionId || !contextEntryId || !requestId || !content) {
      throw new Error("Invalid append-session-context command");
    }
    if (kind !== "collaboration_request" && kind !== "collaboration_result") {
      throw new Error("Invalid collaboration context kind");
    }
    if (!provider.appendSessionContext) {
      throw new Error(`This ${providerName} CLI does not support collaboration context`);
    }
    const context: AppendSessionContextInput = {
      sessionId,
      contextEntryId,
      requestId,
      kind,
      content,
      metadata:
        command.payload.metadata && typeof command.payload.metadata === "object"
          ? command.payload.metadata as Record<string, unknown>
          : {},
    };
    await provider.appendSessionContext(context);
    return true;
  }

  if (command.type === "collaboration-prompt") {
    const requestId = readString(command.payload.requestId);
    const attemptId = readString(command.payload.attemptId);
    const runId = readString(command.payload.runId);
    const protocolVersion = readString(command.payload.protocolVersion);
    const mode = readString(command.payload.mode);
    const targetSessionId = readString(command.payload.targetSessionId);
    const question = readString(command.payload.question);
    if (
      !requestId
      || !attemptId
      || !runId
      || protocolVersion !== "v1"
      || mode !== "consultation"
      || !targetSessionId
      || !question
    ) {
      throw new Error("Invalid collaboration-prompt command");
    }
    if (!provider.startCollaborationConsultation) {
      throw new Error(`This ${providerName} CLI does not support collaboration consultation`);
    }
    await provider.startCollaborationConsultation({
      requestId,
      attemptId,
      runId,
      protocolVersion,
      mode,
      targetSessionId,
      question,
    });
    return true;
  }

  if (command.type !== "abort") return false;

  const requestId = readString(command.payload.collaborationRequestId);
  const attemptId = readString(command.payload.collaborationAttemptId);
  const runId = readString(command.payload.collaborationRunId);
  const code = readString(command.payload.collaborationErrorCode);
  const message = readString(command.payload.collaborationErrorMessage);
  if (!requestId && !attemptId && !runId && !code) return false;
  if (
    !requestId
    || !attemptId
    || !runId
    || (code !== "RUN_TIMEOUT" && code !== "EXECUTION_ABORTED")
    || !message
    || !provider.abortCollaborationConsultation
  ) {
    throw new Error("Invalid collaboration abort command");
  }
  await provider.abortCollaborationConsultation({ requestId, attemptId, runId, code, message });
  return true;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
