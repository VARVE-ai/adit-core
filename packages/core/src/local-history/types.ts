export interface HistoryUsageRecord {
  key: string;
  usage: Record<string, unknown>;
  timestamp?: string;
  model?: string;
  requestId?: string;
  responseId?: string;
}

export interface HistoryMessage {
  key: string;
  role: string;
  timestamp?: string;
  model?: string;
  effort?: string;
  content: unknown;
  usage?: Record<string, unknown>;
  /** Independent native requests, including requests without a visible reply. */
  usageRecords?: HistoryUsageRecord[];
  parentKey?: string;
  raw: Record<string, unknown>;
  finalReply?: boolean;
  contextKind?: "compaction";
  previewExcluded?: boolean;
}

export interface HistorySession {
  id: string;
  provider: string;
  cwd: string;
  parentId?: string;
  relationship?: "fork" | "subagent" | "continuation";
  metadata?: Record<string, unknown>;
  messages: HistoryMessage[];
}

export class HistoryFormatError extends Error {}

export function jsonDocument(text: string): Record<string, unknown> {
  try {
    return record(JSON.parse(text));
  } catch {
    throw new HistoryFormatError(
      "Invalid source JSON; existing data was retained",
    );
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function jsonLines(text: string): Record<string, unknown>[] {
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      const row = JSON.parse(lines[i]);
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error();
      rows.push(row);
    } catch {
      // A live writer may not have finished the last line yet.
      if (i === lines.length - 1 && !text.endsWith("\n")) break;
      throw new HistoryFormatError(`Invalid JSON record at line ${i + 1}`);
    }
  }
  return rows;
}
