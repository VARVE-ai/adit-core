import type { CloudClient } from "./http/client.js";

export interface CloudMemoryQuery {
  scope: "personal" | "project";
  project?: string;
  action?: "show" | "search" | "history" | "evidence";
  q?: string;
  entry?: string;
  version?: number;
  offset?: number;
  limit?: number;
}
export interface CloudMemoryResult {
  scope: "personal" | "project";
  project: { id: string; name: string | null; localProjectId: string } | null;
  document?: { id: string; version: number; markdown: string; updatedAt: string } | null;
  version?: number;
  entries?: Array<{ id: string; topic: string; content: string; status: string; score: number }>;
  entry?: { id: string; content: string; status: string; score: number; reason: string };
  history?: Array<{ version: number; createdAt: string; model: string | null; rulesVersion: string; changedEntries?: number; previousMarkdown?: string; markdown?: string; changes?: unknown[] }>;
  evidence?: Array<{ eventId: string; sessionId: string; quote: string | null; available: boolean; relation: string; role: string }>;
  total?: number;
  nextOffset?: number | null;
}

export function queryCloudMemories(client: CloudClient, input: CloudMemoryQuery): Promise<CloudMemoryResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value));
  return client.get(`/api/cli/memories?${params}`);
}
