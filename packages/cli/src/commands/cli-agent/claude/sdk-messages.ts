import type { SDKMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CliAgentContextUsage } from "../types.js";

export function extractSessionId(message: SDKMessage): string | null {
  const maybe = message as { session_id?: unknown; sessionId?: unknown };
  if (typeof maybe.session_id === "string") return maybe.session_id;
  if (typeof maybe.sessionId === "string") return maybe.sessionId;
  return null;
}

export function makeMessageId(message: SDKMessage, sessionId: string): string {
  const maybe = message as { uuid?: unknown; message?: { id?: unknown } };
  if (typeof maybe.message?.id === "string") return maybe.message.id;
  if (typeof maybe.uuid === "string") return maybe.uuid;
  return `claude-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeClaudeUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const normalized: Record<string, number> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "reasoning_tokens",
  ]) {
    const numberValue = usage[key];
    if (typeof numberValue === "number" && Number.isFinite(numberValue)) {
      normalized[key] = numberValue;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeClaudeContextUsage(
  value: unknown,
  fallbackModelId: string | null,
): CliAgentContextUsage | null {
  const usage = asRecord(value);
  const totalTokens = readNumber(usage.totalTokens);
  const maxTokens = readNumber(usage.maxTokens);
  if (totalTokens === null || totalTokens <= 0 || maxTokens === null || maxTokens <= 0) {
    return null;
  }
  const rawPercentage = readNumber(usage.percentage) ?? totalTokens / maxTokens * 100;
  return {
    percentage: Math.max(0, Math.min(100, rawPercentage)),
    totalTokens: Math.max(0, Math.floor(totalTokens)),
    maxTokens: Math.floor(maxTokens),
    modelId: fallbackModelId,
    updatedAt: Date.now(),
    source: "claude-sdk",
  };
}

export function stableStateEventKey(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export function isSameContextUsage(
  current: CliAgentContextUsage | null,
  next: CliAgentContextUsage,
): boolean {
  return Boolean(
    current &&
      current.percentage === next.percentage &&
      current.totalTokens === next.totalTokens &&
      current.maxTokens === next.maxTokens &&
      current.modelId === next.modelId,
  );
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function partialAssistantStreamKey(message: SDKPartialAssistantMessage, sessionId: string): string {
  const parentToolUseId = readString(message.parent_tool_use_id) ?? "main";
  return `${sessionId}:${parentToolUseId}`;
}

export function claudeReasoningPartId(messageId: string, contentBlockIndex: number): string {
  return `${messageId}-reasoning-${contentBlockIndex}`;
}

export function claudeThinkingPartKey(sessionId: string, messageId: string, contentBlockIndex: number): string {
  return `${sessionId}:${messageId}:${contentBlockIndex}`;
}

export function normalizeQuestionInput(input: Record<string, unknown>): Array<{
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
}> {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
  }> = [];

  for (const rawQuestion of rawQuestions) {
    const questionRecord = asRecord(rawQuestion);
    const question = readString(questionRecord.question);
    if (!question) continue;
    const options = (Array.isArray(questionRecord.options) ? questionRecord.options : [])
      .map((rawOption) => {
        const optionRecord = asRecord(rawOption);
        const label = readString(optionRecord.label);
        if (!label) return null;
        return {
          label,
          description: readString(optionRecord.description) ?? "",
        };
      })
      .filter((option): option is { label: string; description: string } => Boolean(option));
    if (options.length === 0) continue;
    questions.push({
      question,
      header: readString(questionRecord.header) ?? "Question",
      options,
      multiple: questionRecord.multiSelect === true,
    });
  }

  return questions;
}

export function buildQuestionAnswerMap(
  questions: Array<{ question: string }>,
  answers: string[][],
): Record<string, string> {
  const result: Record<string, string> = {};
  questions.forEach((question, index) => {
    const answer = answers[index] ?? [];
    result[question.question] = answer.filter(Boolean).join(", ");
  });
  return result;
}

export function formatToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export function formatClaudeCompactionOutput(input: {
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
}): string {
  const details: string[] = [];
  if (input.trigger) details.push(`trigger=${input.trigger}`);
  if (input.preTokens !== null && input.postTokens !== null) {
    details.push(`tokens ${input.preTokens} -> ${input.postTokens}`);
  } else if (input.preTokens !== null) {
    details.push(`preTokens=${input.preTokens}`);
  }
  if (input.durationMs !== null) details.push(`duration=${formatRetryDelay(input.durationMs)}`);
  return details.length > 0
    ? `Claude context compaction completed (${details.join(", ")}).`
    : "Claude context compaction completed.";
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readDeltaString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatRetryDelay(delayMs: number): string {
  if (delayMs <= 0) return "0s";
  if (delayMs % 1000 === 0) return `${delayMs / 1000}s`;
  return `${(delayMs / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
