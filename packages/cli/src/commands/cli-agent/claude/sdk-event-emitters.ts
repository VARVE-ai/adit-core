import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  TODO_WRITE_TOOL,
  claudeToolScope,
  type CliPromptMode,
} from "./capabilities.js";
import {
  CLAUDE_SYNTHETIC_DELTA_INTERVAL_MS,
  chunkTextForSyntheticDeltas,
  sleep,
} from "./prompt-stream.js";
import {
  asRecord,
  claudeReasoningPartId,
  claudeThinkingPartKey,
  formatClaudeCompactionOutput,
  formatRetryDelay,
  formatToolResult,
  makeMessageId,
  normalizeClaudeUsage,
  partialAssistantStreamKey,
  readDeltaString,
  readNumber,
  readString,
} from "./sdk-messages.js";
import { normalizeClaudeTodoWriteInput } from "./todos.js";

export interface PartialAssistantStreamState {
  messageId: string;
}

// Pairs streamed thinking blocks with their final full-text counterparts so both
// emit the same partId. The SDK re-indexes each final message's content array to
// a single element (index 0), while stream deltas carry the original response
// block index — without pairing, every thinking block after the first leaves an
// orphaned streaming part and overwrites the first block's final text.
export class ClaudeThinkingPartTracker {
  private streamedKeys = new Set<string>();
  private pendingByMessage = new Map<string, number[]>();
  private finalOrdinals = new Map<string, number>();

  clear(): void {
    this.streamedKeys = new Set<string>();
    this.pendingByMessage = new Map<string, number[]>();
    this.finalOrdinals = new Map<string, number>();
  }

  notePartialThinking(
    sessionId: string,
    messageId: string,
    contentBlockIndex: number,
  ): string {
    const key = claudeThinkingPartKey(sessionId, messageId, contentBlockIndex);
    if (!this.streamedKeys.has(key)) {
      this.streamedKeys.add(key);
      const queueKey = `${sessionId}\0${messageId}`;
      const queue = this.pendingByMessage.get(queueKey) ?? [];
      queue.push(contentBlockIndex);
      this.pendingByMessage.set(queueKey, queue);
    }
    return claudeReasoningPartId(messageId, contentBlockIndex);
  }

  takeFinalThinking(
    sessionId: string,
    messageId: string,
  ): { partId: string; contentBlockIndex: number; streamed: boolean } {
    const queueKey = `${sessionId}\0${messageId}`;
    const queue = this.pendingByMessage.get(queueKey);
    if (queue && queue.length > 0) {
      const index = queue.shift() as number;
      if (queue.length === 0) this.pendingByMessage.delete(queueKey);
      this.streamedKeys.delete(claudeThinkingPartKey(sessionId, messageId, index));
      const nextOrdinal = Math.max(this.finalOrdinals.get(queueKey) ?? 0, index + 1);
      this.finalOrdinals.set(queueKey, nextOrdinal);
      return {
        partId: claudeReasoningPartId(messageId, index),
        contentBlockIndex: index,
        streamed: true,
      };
    }
    const ordinal = this.finalOrdinals.get(queueKey) ?? 0;
    this.finalOrdinals.set(queueKey, ordinal + 1);
    return {
      partId: claudeReasoningPartId(messageId, ordinal),
      contentBlockIndex: ordinal,
      streamed: false,
    };
  }
}

export interface ClaudeToolUseState {
  messageId: string;
  toolName: string;
  input: unknown;
  mode?: CliPromptMode;
  modelId?: string;
  usage?: Record<string, number>;
}

interface ContextCompactionToolState {
  id: string;
  completed: boolean;
  completedAt?: number;
}

export interface ClaudeSdkEventContext {
  activeModelId: () => string | null;
  activePromptMode: () => CliPromptMode | null;
  ownerValue: () => string;
  remoteLoopGeneration: () => number;
  remoteAbortSignalAborted: () => boolean;
  contextCompactionToolBySession: Map<string, ContextCompactionToolState>;
  lastAssistantMessageBySession: Map<string, string>;
  lastAssistantTextBySession: Map<string, string>;
  toolUseById: Map<string, ClaudeToolUseState>;
  partialAssistantStreams: Map<string, PartialAssistantStreamState>;
  streamedTextMessageIds: Set<string>;
  thinkingParts: ClaudeThinkingPartTracker;
  pushEvent: (type: string, payload: Record<string, unknown>) => void;
}

const CONTEXT_COMPACTION_TOOL_MERGE_WINDOW_MS = 30_000;

export function emitClaudeCompactStatus(
  message: SDKMessage,
  sessionId: string,
  ctx: ClaudeSdkEventContext,
): void {
  const record = asRecord(message);
  const status = readString(record.status);
  const compactResult = readString(record.compact_result);
  const compactError = readString(record.compact_error);
  if (status !== "compacting" && !compactResult) return;

  if (status === "compacting") {
    const toolUseId = contextCompactionToolId(sessionId, readString(record.uuid), true, ctx);
    emitContextCompactionTool({
      sessionId,
      toolUseId,
      input: { source: "claude" },
      status: "running",
    }, ctx);
  }

  if (compactResult) {
    const failed = compactResult === "failed";
    const toolUseId = contextCompactionToolId(sessionId, readString(record.uuid), false, ctx);
    emitContextCompactionTool({
      sessionId,
      toolUseId,
      input: { source: "claude", result: compactResult },
      output: failed ? undefined : "Claude context compaction completed.",
      error: failed ? compactError ?? "Claude context compaction failed." : undefined,
      status: failed ? "error" : "completed",
    }, ctx);
  }
}

export function emitClaudeCompactBoundary(
  message: SDKMessage,
  sessionId: string,
  ctx: ClaudeSdkEventContext,
): void {
  const record = asRecord(message);
  const metadata = asRecord(record.compact_metadata);
  const trigger = readString(metadata.trigger);
  const preTokens = readNumber(metadata.pre_tokens);
  const postTokens = readNumber(metadata.post_tokens);
  const durationMs = readNumber(metadata.duration_ms);
  const input = {
    source: "claude",
    ...(trigger ? { trigger } : {}),
    ...(preTokens !== null ? { preTokens } : {}),
    ...(postTokens !== null ? { postTokens } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
  };
  const toolUseId = contextCompactionToolId(sessionId, readString(record.uuid), false, ctx);
  emitContextCompactionTool({
    sessionId,
    toolUseId,
    input,
    output: formatClaudeCompactionOutput({ trigger, preTokens, postTokens, durationMs }),
    status: "completed",
  }, ctx);
}

function contextCompactionToolId(
  sessionId: string,
  fallbackId: string | null,
  running: boolean,
  ctx: ClaudeSdkEventContext,
): string {
  const existing = ctx.contextCompactionToolBySession.get(sessionId);
  if (running && existing && !existing.completed) return existing.id;
  const now = Date.now();
  if (
    !running &&
    existing &&
    (!existing.completed ||
      (existing.completedAt !== undefined &&
        now - existing.completedAt <= CONTEXT_COMPACTION_TOOL_MERGE_WINDOW_MS))
  ) {
    ctx.contextCompactionToolBySession.set(sessionId, {
      id: existing.id,
      completed: true,
      completedAt: now,
    });
    return existing.id;
  }
  const id = fallbackId ?? `claude-compact-${sessionId}-${Date.now()}`;
  ctx.contextCompactionToolBySession.set(sessionId, {
    id,
    completed: !running,
    ...(running ? {} : { completedAt: now }),
  });
  return id;
}

function emitContextCompactionTool(input: {
  sessionId: string;
  toolUseId: string;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  status: "running" | "completed" | "error";
}, ctx: ClaudeSdkEventContext): void {
  ctx.pushEvent("tool", {
    sessionId: input.sessionId,
    messageId: ctx.lastAssistantMessageBySession.get(input.sessionId) ?? `claude-tools-${input.sessionId}`,
    toolUseId: input.toolUseId,
    toolName: "Context compaction",
    input: input.input,
    tool_scope: "internal",
    mode: ctx.activePromptMode() ?? undefined,
    output: input.output,
    error: input.error,
    status: input.status,
    createdAt: Date.now(),
  });
}

export async function emitClaudeAssistantMessage(
  message: SDKAssistantMessage,
  sessionId: string,
  ctx: ClaudeSdkEventContext,
): Promise<void> {
  const content = message.message?.content;
  if (!Array.isArray(content)) return;
  const messageId = makeMessageId(message, sessionId);
  const parentToolUseId = readString((message as { parent_tool_use_id?: unknown }).parent_tool_use_id);
  const eventModelId = ctx.activeModelId() ?? undefined;
  const mode = ctx.activePromptMode() ?? undefined;
  const usage = normalizeClaudeUsage((message.message as { usage?: unknown }).usage);
  ctx.lastAssistantMessageBySession.set(sessionId, messageId);
  for (const part of content as unknown as Array<Record<string, unknown>>) {
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      if (!ctx.streamedTextMessageIds.has(messageId)) {
        const completed = await emitSyntheticAssistantDeltas({
          sessionId,
          messageId,
          modelId: eventModelId,
          text: part.text,
          mode,
        }, ctx);
        if (!completed) return;
      }
      ctx.lastAssistantTextBySession.set(sessionId, part.text);
      ctx.pushEvent("message", {
        role: "assistant",
        sessionId,
        messageId,
        modelId: eventModelId,
        usage,
        text: part.text,
        mode,
        createdAt: Date.now(),
      });
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      // Consume the pairing slot even for whitespace-only blocks so later
      // segments keep matching their streamed parts in order.
      const taken = ctx.thinkingParts.takeFinalThinking(sessionId, messageId);
      if (!part.thinking.trim()) continue;
      ctx.pushEvent("reasoning", {
        sessionId,
        messageId,
        partId: taken.partId,
        contentBlockIndex: taken.contentBlockIndex,
        modelId: eventModelId,
        usage,
        text: part.thinking,
        replace: taken.streamed ? true : undefined,
        mode,
        createdAt: Date.now(),
      });
    } else if (part.type === "tool_use" || part.type === "server_tool_use") {
      const createdAt = Date.now();
      const toolUseId = typeof part.id === "string" ? part.id : undefined;
      const toolName = typeof part.name === "string" ? part.name : "tool";
      const input = part.input ?? {};
      if (toolUseId) {
        ctx.toolUseById.set(toolUseKey(sessionId, toolUseId), {
          messageId,
          toolName,
          input,
          mode,
          modelId: eventModelId,
          usage,
        });
      }
      ctx.pushEvent("tool", {
        sessionId,
        messageId,
        modelId: eventModelId,
        usage,
        toolUseId,
        toolName,
        input,
        tool_scope: claudeToolScope(toolName, ctx.activePromptMode(), input),
        mode,
        inputKind: "prompt",
        status: "running",
        createdAt,
      });
      if (toolName === TODO_WRITE_TOOL) {
        emitClaudeTodoWrite({
          sessionId,
          messageId,
          toolUseId,
          parentToolUseId,
          input,
          createdAt,
        }, ctx);
      }
    } else if (part.type === "tool_result") {
      // Anthropic-compatible relays (e.g. Z.ai server tools such as webReader)
      // return tool results inside assistant messages instead of user messages;
      // emit the completion so the tool does not stay "running" forever.
      emitClaudeToolResultPart(part, sessionId, messageId, ctx);
    }
  }
}

async function emitSyntheticAssistantDeltas(input: {
  sessionId: string;
  messageId: string;
  modelId?: string;
  text: string;
  mode?: CliPromptMode;
}, ctx: ClaudeSdkEventContext): Promise<boolean> {
  const generation = ctx.remoteLoopGeneration();
  const chunks = chunkTextForSyntheticDeltas(input.text);
  ctx.streamedTextMessageIds.add(input.messageId);
  for (let index = 0; index < chunks.length; index += 1) {
    if (!canContinueSyntheticAssistantDeltas(generation, ctx)) return false;
    ctx.pushEvent("assistant-delta", {
      sessionId: input.sessionId,
      messageId: input.messageId,
      modelId: input.modelId,
      text: chunks[index],
      mode: input.mode,
      createdAt: Date.now(),
    });
    if (index < chunks.length - 1) {
      await sleep(CLAUDE_SYNTHETIC_DELTA_INTERVAL_MS);
    }
  }
  return canContinueSyntheticAssistantDeltas(generation, ctx);
}

function canContinueSyntheticAssistantDeltas(
  generation: number,
  ctx: ClaudeSdkEventContext,
): boolean {
  return ctx.ownerValue() === "web" &&
    ctx.remoteLoopGeneration() === generation &&
    !ctx.remoteAbortSignalAborted();
}

export function emitClaudePartialAssistantMessage(
  message: SDKPartialAssistantMessage,
  fallbackSessionId: string,
  ctx: ClaudeSdkEventContext,
): void {
  const sessionId = readString(message.session_id) ?? fallbackSessionId;
  const event = asRecord(message.event);
  const eventType = readString(event.type);
  const streamKey = partialAssistantStreamKey(message, sessionId);

  if (eventType === "message_start") {
    const started = createPartialAssistantStreamState(message, sessionId, event);
    ctx.partialAssistantStreams.set(streamKey, started);
    ctx.lastAssistantMessageBySession.set(sessionId, started.messageId);
    return;
  }

  if (eventType === "message_stop") {
    ctx.partialAssistantStreams.delete(streamKey);
    return;
  }

  if (eventType !== "content_block_delta") return;
  const delta = asRecord(event.delta);
  const deltaType = readString(delta.type);
  const text = deltaType === "thinking_delta"
    ? readDeltaString(delta.thinking)
    : deltaType === "text_delta"
      ? readDeltaString(delta.text)
      : null;
  if (!text) return;

  const stream = ctx.partialAssistantStreams.get(streamKey) ??
    createPartialAssistantStreamState(message, sessionId, event);
  ctx.partialAssistantStreams.set(streamKey, stream);
  ctx.lastAssistantMessageBySession.set(sessionId, stream.messageId);
  if (deltaType === "thinking_delta") {
    const contentBlockIndex = readNumber(event.index) ?? 0;
    const partId = ctx.thinkingParts.notePartialThinking(
      sessionId,
      stream.messageId,
      contentBlockIndex,
    );
    ctx.pushEvent("reasoning", {
      sessionId,
      messageId: stream.messageId,
      partId,
      contentBlockIndex,
      modelId: ctx.activeModelId() ?? undefined,
      text,
      delta: true,
      mode: ctx.activePromptMode() ?? undefined,
      createdAt: Date.now(),
    });
    return;
  }

  if (deltaType !== "text_delta") return;
  ctx.streamedTextMessageIds.add(stream.messageId);
  ctx.pushEvent("assistant-delta", {
    sessionId,
    messageId: stream.messageId,
    modelId: ctx.activeModelId() ?? undefined,
    text,
    mode: ctx.activePromptMode() ?? undefined,
    createdAt: Date.now(),
  });
}

function createPartialAssistantStreamState(
  message: SDKPartialAssistantMessage,
  sessionId: string,
  event: Record<string, unknown>,
): PartialAssistantStreamState {
  const startedMessage = asRecord(event.message);
  const messageId = readString(startedMessage.id) ??
    readString((message as { uuid?: unknown }).uuid) ??
    `claude-stream-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { messageId };
}

export function emitClaudeApiRetry(
  message: SDKAPIRetryMessage,
  sessionId: string,
  ctx: ClaudeSdkEventContext,
): void {
  const attempt = readNumber(message.attempt);
  const maxRetries = readNumber(message.max_retries) ??
    readNumber((message as { maxRetries?: unknown }).maxRetries);
  const retryDelayMs = readNumber(message.retry_delay_ms) ??
    readNumber((message as { retryDelayMs?: unknown }).retryDelayMs);
  const errorStatus = readNumber(message.error_status);
  const error = readString(message.error);
  const retryLabel = errorStatus === 529 || error === "overloaded"
    ? "API overloaded"
    : errorStatus !== null
      ? `API error ${errorStatus}`
      : "API request failed";
  const retryText = attempt !== null && maxRetries !== null && retryDelayMs !== null
    ? `${retryLabel}, retrying ${attempt}/${maxRetries} in ${formatRetryDelay(retryDelayMs)}...`
    : `${retryLabel}, retrying...`;
  ctx.pushEvent("run.retry", {
    sessionId,
    ...(ctx.activeModelId() ? { modelId: ctx.activeModelId() } : {}),
    attempt,
    maxRetries,
    retryDelayMs,
    retryDelaySeconds: retryDelayMs === null ? null : Math.ceil(retryDelayMs / 1000),
    errorStatus,
    error,
    message: retryText,
    mode: ctx.activePromptMode() ?? undefined,
    createdAt: Date.now(),
  });
}

export function emitClaudeResultError(
  message: SDKMessage,
  sessionId: string,
  ctx: ClaudeSdkEventContext,
): void {
  const result = message as {
    result_type?: unknown;
    resultType?: unknown;
    subtype?: unknown;
    is_error?: unknown;
    errors?: unknown;
    result?: unknown;
    api_error_status?: unknown;
  };
  const subtype = readString(result.subtype);
  const isError = result.is_error === true || Boolean(subtype?.startsWith("error_"));
  if (!isError) return;
  const errors = Array.isArray(result.errors)
    ? result.errors.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const resultType = readString(result.result_type) ?? readString(result.resultType);
  if (
    resultType === "user" ||
    errors.some((error) =>
      error.includes("[ede_diagnostic]") && error.includes("result_type=user")
    )
  ) {
    return;
  }
  // Auth/API failures arrive as subtype "success" with is_error set; the
  // human-readable text lives in the result field, not in errors.
  const resultText = readString(result.result);
  // The CLI surfaces these failures as a synthetic assistant reply carrying
  // the same text; an error card on top would repeat the transcript.
  if (
    errors.length === 0 &&
    resultText &&
    ctx.lastAssistantTextBySession.get(sessionId)?.trim() === resultText.trim()
  ) {
    return;
  }
  const messageText = errors.length > 0
    ? errors.join("\n")
    : resultText ??
      (subtype ? `Claude SDK result failed: ${subtype}` : "Claude SDK result failed.");
  ctx.pushEvent("error", {
    title: "Claude request failed",
    message: messageText,
    sessionId,
    ...(ctx.activeModelId() ? { modelId: ctx.activeModelId() } : {}),
    ...(readNumber(result.api_error_status) !== null
      ? { errorStatus: readNumber(result.api_error_status) }
      : {}),
    mode: ctx.activePromptMode() ?? undefined,
    createdAt: Date.now(),
  });
}

function emitClaudeTodoWrite(input: {
  sessionId: string;
  messageId: string;
  toolUseId?: string;
  parentToolUseId: string | null;
  input: unknown;
  createdAt: number;
}, ctx: Pick<ClaudeSdkEventContext, "pushEvent">): void {
  const todos = normalizeClaudeTodoWriteInput(input.input);
  if (!todos) return;
  ctx.pushEvent("todos.updated", {
    sessionId: input.sessionId,
    messageId: input.messageId,
    toolUseId: input.toolUseId,
    parentToolUseId: input.parentToolUseId,
    scopeId: input.parentToolUseId ?? "main",
    todos,
    createdAt: input.createdAt,
  });
}

export function emitClaudeResultUsage(
  message: SDKMessage,
  fallbackSessionId: string,
  ctx: Pick<ClaudeSdkEventContext, "lastAssistantMessageBySession" | "pushEvent">,
): void {
  const result = message as {
    session_id?: unknown;
    sessionId?: unknown;
    usage?: unknown;
    total_cost_usd?: unknown;
  };
  const usage = normalizeClaudeUsage(result.usage);
  if (!usage) return;
  const sessionId = fallbackSessionId ||
    (typeof result.session_id === "string"
      ? result.session_id
      : typeof result.sessionId === "string"
        ? result.sessionId
        : fallbackSessionId);
  ctx.pushEvent("usage", {
    sessionId,
    messageId: ctx.lastAssistantMessageBySession.get(sessionId),
    usage,
    cost: typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd)
      ? result.total_cost_usd
      : undefined,
    createdAt: Date.now(),
  });
}

export function emitClaudeToolResults(
  message: SDKUserMessage,
  sessionId: string,
  ctx: Pick<
    ClaudeSdkEventContext,
    "activePromptMode" | "lastAssistantMessageBySession" | "pushEvent" | "toolUseById"
  >,
): void {
  const content = message.message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content as unknown as Array<Record<string, unknown>>) {
    if (part.type !== "tool_result") continue;
    emitClaudeToolResultPart(part, sessionId, makeMessageId(message, sessionId), ctx);
  }
}

function emitClaudeToolResultPart(
  part: Record<string, unknown>,
  sessionId: string,
  fallbackMessageId: string,
  ctx: Pick<
    ClaudeSdkEventContext,
    "activePromptMode" | "lastAssistantMessageBySession" | "pushEvent" | "toolUseById"
  >,
): void {
  const toolUseId = typeof part.tool_use_id === "string"
    ? part.tool_use_id
    : typeof part.toolUseID === "string"
      ? part.toolUseID
      : "tool";
  const toolUse = ctx.toolUseById.get(toolUseKey(sessionId, toolUseId));
  const toolName = toolUse?.toolName ?? "tool";
  const input = toolUse?.input ?? {};
  const mode = toolUse?.mode ?? ctx.activePromptMode() ?? undefined;
  ctx.pushEvent("tool", {
    sessionId,
    messageId: toolUse?.messageId ??
      ctx.lastAssistantMessageBySession.get(sessionId) ??
      fallbackMessageId,
    modelId: toolUse?.modelId,
    usage: toolUse?.usage,
    toolUseId,
    toolName,
    input,
    tool_scope: claudeToolScope(toolName, toolUse?.mode ?? ctx.activePromptMode(), input),
    mode,
    inputKind: "prompt",
    output: formatToolResult(part.content),
    status: "completed",
    createdAt: Date.now(),
  });
}

export function toolUseKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}\0${toolUseId}`;
}
