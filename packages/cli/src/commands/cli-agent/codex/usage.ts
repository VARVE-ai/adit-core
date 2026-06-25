import type { CliAgentContextUsage, CliAgentTokenUsage } from "../types.js";
import { readNumber } from "./helpers.js";

export const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

export const CODEX_MODEL_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/^gpt-5\.5(?:$|[-_\s])/, 1_050_000],
  [/^gpt-5(?:\.\d+)?(?:-codex(?:-max|-mini)?|-chat-latest)?(?:$|[-_\s])/, 400_000],
];

export function normalizeCodexUsage(value: Record<string, unknown> | null): Record<string, number> | undefined {
  if (!value) return undefined;
  const usage = {
    input_tokens: readNumber(value.inputTokens) ?? 0,
    output_tokens: readNumber(value.outputTokens) ?? 0,
    reasoning_tokens: readNumber(value.reasoningOutputTokens) ?? 0,
    cache_read_input_tokens: readNumber(value.cachedInputTokens) ?? 0,
  };
  return Object.values(usage).some((item) => item > 0) ? usage : undefined;
}

export function normalizeCodexTokenUsage(value: Record<string, unknown> | null): CliAgentTokenUsage | null {
  if (!value) return null;
  const totalTokens = readNumber(value.totalTokens);
  const usage: CliAgentTokenUsage = {
    ...(totalTokens !== null ? { totalTokens } : {}),
    inputTokens: readNumber(value.inputTokens) ?? 0,
    outputTokens: readNumber(value.outputTokens) ?? 0,
    reasoningTokens: readNumber(value.reasoningOutputTokens) ?? 0,
    cacheReadTokens: readNumber(value.cachedInputTokens) ?? 0,
    cacheWriteTokens: readNumber(value.cacheCreationInputTokens) ?? 0,
    updatedAt: Date.now(),
    source: "codex-app-server",
  };
  return Object.values({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  }).some((item) => item > 0)
    ? usage
    : null;
}

export function buildCodexContextUsage(
  usage: CliAgentTokenUsage | null,
  modelId: string | null,
  runtimeContextWindow: number | null = null,
): CliAgentContextUsage | null {
  const maxTokens = runtimeContextWindow ?? getCodexModelContextWindow(modelId);
  if (!usage || maxTokens === null) return null;
  const outputTokens = Math.max(usage.outputTokens, usage.reasoningTokens);
  const totalTokens = Math.max(
    0,
    Math.floor(usage.totalTokens ?? usage.inputTokens + outputTokens),
  );
  return {
    percentage: calculateCodexContextUsedPercentage(totalTokens, maxTokens),
    totalTokens,
    maxTokens,
    modelId: modelId ?? undefined,
    updatedAt: usage.updatedAt,
    source: "codex-app-server",
  };
}

export function calculateCodexContextUsedPercentage(totalTokens: number, maxTokens: number): number {
  if (maxTokens <= CODEX_CONTEXT_BASELINE_TOKENS) return 100;
  const effectiveWindow = maxTokens - CODEX_CONTEXT_BASELINE_TOKENS;
  const usedTokens = Math.max(0, totalTokens - CODEX_CONTEXT_BASELINE_TOKENS);
  const remainingTokens = Math.max(0, effectiveWindow - usedTokens);
  const remainingPercent = Math.round(remainingTokens / effectiveWindow * 100);
  return Math.max(0, Math.min(100, 100 - remainingPercent));
}

export function normalizeCodexContextWindow(value: number | null): number | null {
  return value !== null && value > 0 ? Math.floor(value) : null;
}

export function getCodexModelContextWindow(modelId: string | null): number | null {
  if (!modelId) return null;
  const normalized = modelId.trim().toLowerCase();
  for (const [pattern, maxTokens] of CODEX_MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(normalized)) return maxTokens;
  }
  return null;
}

export function isSameContextUsage(
  current: CliAgentContextUsage | null,
  next: CliAgentContextUsage | null,
): boolean {
  if (!current || !next) return current === next;
  return Boolean(
    current.percentage === next.percentage &&
      current.totalTokens === next.totalTokens &&
      current.maxTokens === next.maxTokens &&
      current.modelId === next.modelId &&
      current.source === next.source,
  );
}

export function isSameTokenUsage(
  current: CliAgentTokenUsage | null,
  next: CliAgentTokenUsage,
): boolean {
  return Boolean(
    current &&
      current.inputTokens === next.inputTokens &&
      current.totalTokens === next.totalTokens &&
      current.outputTokens === next.outputTokens &&
      current.reasoningTokens === next.reasoningTokens &&
      current.cacheReadTokens === next.cacheReadTokens &&
      current.cacheWriteTokens === next.cacheWriteTokens,
  );
}
