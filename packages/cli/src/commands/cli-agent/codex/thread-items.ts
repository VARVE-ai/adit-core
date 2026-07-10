import {
  CODEX_UPDATE_PLAN_TOOL,
  normalizeCodexUpdatePlanInput,
  parseCodexToolInput,
} from "./codex-plan-normalizer.js";
import { readString, readStringArray, safeJson } from "./helpers.js";
import type { CodexPromptMode } from "./input-mode.js";
import { codexToolScope, isCodexToolItemType } from "./requests.js";

interface CodexThreadItemContext {
  activeSessionId: string | null;
  resumeSessionId: string | null;
  activeModelId: string | null;
  activePromptMode: CodexPromptMode | null;
  emptyThreadIds: Set<string>;
  lastAssistantMessageBySession: Map<string, string>;
  pushEvent: (type: string, payload: Record<string, unknown>) => void;
}

export function emitCodexThreadItem(
  item: Record<string, unknown> | null,
  opts: { threadId: string | null; running: boolean },
  ctx: CodexThreadItemContext,
): void {
  if (!item) return;
  const type = readString(item.type);
  const sessionId = opts.threadId ?? ctx.activeSessionId ?? ctx.resumeSessionId;
  const id = readString(item.id);
  if (!type || !sessionId || !id) return;
  const createdAt = Date.now();
  ctx.emptyThreadIds.delete(sessionId);

  if ((type === "agentMessage" || type === "plan") && !opts.running) {
    const text = readString(item.text);
    if (!text) return;
    ctx.lastAssistantMessageBySession.set(sessionId, id);
    ctx.pushEvent("message", {
      role: "assistant",
      sessionId,
      messageId: id,
      modelId: ctx.activeModelId ?? undefined,
      text,
      mode: ctx.activePromptMode ?? undefined,
      createdAt,
    });
    return;
  }

  if (type === "reasoning" && !opts.running) {
    const content = [
      ...readStringArray(item.summary),
      ...readStringArray(item.content),
    ].join("\n");
    if (!content) return;
    ctx.pushEvent("reasoning", {
      sessionId,
      messageId: id,
      text: content,
      mode: ctx.activePromptMode ?? undefined,
      createdAt,
    });
    return;
  }

  if (type === "contextCompaction") {
    ctx.pushEvent("tool", {
      sessionId,
      messageId: ctx.lastAssistantMessageBySession.get(sessionId) ?? `codex-tools-${sessionId}`,
      toolUseId: id,
      toolName: "Context compaction",
      input: { source: "codex" },
      tool_scope: "internal",
      mode: ctx.activePromptMode ?? undefined,
      output: opts.running ? undefined : "Context compaction completed.",
      status: opts.running ? "running" : "completed",
      createdAt,
    });
    return;
  }

  if (type === "commandExecution") {
    const command = readString(item.command) ?? "command";
    const status = readString(item.status);
    ctx.pushEvent("tool", {
      sessionId,
      messageId: ctx.lastAssistantMessageBySession.get(sessionId) ?? `codex-tools-${sessionId}`,
      toolUseId: id,
      toolName: "Bash",
      input: {
        command,
        cwd: readString(item.cwd),
        source: item.source,
        commandActions: item.commandActions,
      },
      tool_scope: codexToolScope("Bash", ctx.activePromptMode),
      mode: ctx.activePromptMode ?? undefined,
      inputKind: "prompt",
      output: readString(item.aggregatedOutput) ?? undefined,
      error: status === "failed" ? readString(item.aggregatedOutput) ?? "Command failed" : undefined,
      status: opts.running || status === "inProgress"
        ? "running"
        : status === "completed"
          ? "completed"
          : "error",
      createdAt,
    });
    return;
  }

  if (type === "fileChange") {
    const status = readString(item.status);
    ctx.pushEvent("tool", {
      sessionId,
      messageId: ctx.lastAssistantMessageBySession.get(sessionId) ?? `codex-tools-${sessionId}`,
      toolUseId: id,
      toolName: "apply_patch",
      input: { changes: item.changes },
      tool_scope: codexToolScope("apply_patch", ctx.activePromptMode),
      mode: ctx.activePromptMode ?? undefined,
      inputKind: "prompt",
      output: status === "completed" ? safeJson(item.changes) : undefined,
      error: status === "failed" || status === "declined" ? `File change ${status}` : undefined,
      status: opts.running || status === "inProgress"
        ? "running"
        : status === "completed"
          ? "completed"
          : "error",
      createdAt,
    });
    return;
  }

  if (isCodexToolItemType(type)) {
    const toolName = readString(item.tool) ??
      readString(item.name) ??
      readString(item.toolName) ??
      readString(item.server) ??
      type;
    const status = readString(item.status);
    const messageId = ctx.lastAssistantMessageBySession.get(sessionId) ?? `codex-tools-${sessionId}`;
    const input = item.arguments !== undefined
      ? parseCodexToolInput(item.arguments)
      : item.input !== undefined
        ? parseCodexToolInput(item.input)
        : item.toolInput !== undefined
          ? parseCodexToolInput(item.toolInput)
          : { query: item.query };
    ctx.pushEvent("tool", {
      sessionId,
      messageId,
      toolUseId: id,
      toolName,
      input,
      tool_scope: codexToolScope(toolName, ctx.activePromptMode),
      mode: ctx.activePromptMode ?? undefined,
      inputKind: "prompt",
      output: item.result !== undefined ? safeJson(item.result) : undefined,
      error: item.error !== undefined ? safeJson(item.error) : undefined,
      status: opts.running || status === "inProgress" || status === "running"
        ? "running"
        : item.error ? "error" : "completed",
      createdAt,
    });
    if (toolName === CODEX_UPDATE_PLAN_TOOL) {
      emitCodexUpdatePlan({
        sessionId,
        messageId,
        toolUseId: id,
        input,
        createdAt,
      }, ctx);
    }
  }
}

function emitCodexUpdatePlan(
  input: {
    sessionId: string;
    messageId: string;
    toolUseId: string;
    input: unknown;
    createdAt: number;
  },
  ctx: Pick<CodexThreadItemContext, "pushEvent">,
): void {
  const snapshot = normalizeCodexUpdatePlanInput(input.input);
  if (!snapshot) return;
  ctx.pushEvent("todos.updated", {
    sessionId: input.sessionId,
    messageId: input.messageId,
    toolUseId: input.toolUseId,
    scopeId: "main",
    todos: snapshot.todos,
    ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
    createdAt: input.createdAt,
  });
}
