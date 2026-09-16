export const usageFields = [
  "input_tokens", "output_tokens", "cached_input_tokens", "cache_read_input_tokens",
  "cache_creation_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens", "total_tokens",
] as const;

export interface TokenUsageRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  sessionId: string;
  turnId: string | null;
  provider: "codex" | "claude";
  model: string | null;
  requestId: string | null;
  responseId: string | null;
  source: "transcript";
  granularity: "request" | "observation" | "gap";
  occurredAt: string;
  raw: Record<string, number>;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  complete: boolean;
}

export function sanitizeUsage(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(usageFields.flatMap((field) => {
    const amount = raw[field];
    return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0
      ? [[field, amount]] : [];
  }));
}

export function normalizeUsage(provider: "claude" | "codex", value: unknown) {
  const raw = sanitizeUsage(value);
  const outputTokens = raw.output_tokens ?? null;
  const cacheReadTokens = (provider === "claude" ? raw.cache_read_input_tokens : raw.cached_input_tokens) ?? null;
  const cacheWriteTokens = (provider === "claude" ? raw.cache_creation_input_tokens : raw.cache_write_input_tokens) ?? null;
  const reasoningTokens = raw.reasoning_output_tokens ?? null;
  let inputTokens: number | null = raw.input_tokens ?? null;
  if (provider === "claude") {
    inputTokens = inputTokens !== null && cacheReadTokens !== null && cacheWriteTokens !== null
      ? inputTokens + cacheReadTokens + cacheWriteTokens : null;
  }
  let totalTokens: number | null = inputTokens !== null && outputTokens !== null
    && Number.isSafeInteger(inputTokens + outputTokens) ? inputTokens + outputTokens : null;
  if (raw.total_tokens !== undefined && raw.total_tokens !== totalTokens) totalTokens = null;
  if (inputTokens !== null && !Number.isSafeInteger(inputTokens)) inputTokens = null;
  return { raw, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens };
}
