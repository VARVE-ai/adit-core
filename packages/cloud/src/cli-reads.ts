/**
 * Typed calls to the Cloud endpoints the read-only CLI commands use
 * (/api/cli/...): projects, teams, sessions, read links, commits, usage and
 * daily reports. Every function returns the server's JSON as is.
 */

import type { CloudClient } from "./http/client.js";

type QueryValue = string | number | boolean | null | undefined;

function query(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, QueryValue>)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export interface CloudPeriodParams { from?: string | null; to?: string | null; timeZone?: string | null }
export interface CloudScopeParams { project?: string | null; team?: string | null; member?: string | null }
export interface CloudPageParams { offset?: number | null; limit?: number | null }

export interface CloudPeriod { from: string | null; to: string | null; timeZone: string }
export interface CloudPerson { id: string; name: string | null; email: string | null }
export type CloudRole = "owner" | "lead" | "member";

export interface CloudProject {
  id: string; name: string | null; localProjectId: string | null; kind: "personal" | "team";
  owner: CloudPerson | null; teams: Array<{ id: string; name: string }>;
  repositories: Array<{ name: string; url: string | null }>; lastActivityAt: string | null;
}
export interface CloudTeam { id: string; name: string; description: string | null; role: CloudRole; canQueryOthers: boolean; memberCount: number; projects: Array<{ id: string; name: string | null }> }

export interface CloudSessionAnalysis { state: "none" | "pending" | "failed" | "ready" | "updating" | "partial"; sections: number; pendingBatches: number; failedBatches: number }
export interface CloudSessionSummary {
  id: string; title: string | null; platform: string; project: { id: string; name: string | null }; user: CloudPerson;
  startedAt: string; lastActivityAt: string; promptCount: number; commitCount: number; fileCount: number; analysis: CloudSessionAnalysis;
}
/** A list or search row: only the analysis state travels with it. */
export type CloudSessionRow = Omit<CloudSessionSummary, "analysis"> & { analysis: { state: CloudSessionAnalysis["state"] } };
export interface CloudSessionMatch { kind: "outline"; sequence: number; title: string; field: "title" | "keywords" | "description"; snippet: string }
export interface CloudSessionList { sessions: CloudSessionRow[]; total: number; nextOffset: number | null; period: CloudPeriod; scope: { description: string } }
export interface CloudSessionSearch extends Omit<CloudSessionList, "sessions"> { query: string; searchMode: string; sessions: Array<CloudSessionRow & { score: number; matches: CloudSessionMatch[] }>; scopeTruncated: boolean }
export interface CloudOutlineSection { sequence: number; title: string; keywords: string[]; description: string | null; startedAt: string; endedAt: string; eventCount: number }
export interface CloudSessionDetail {
  session: CloudSessionSummary; teams: Array<{ id: string; name: string }>; outline: CloudOutlineSection[];
  coverage: { uncoveredCount: number; pendingBatches: number; failedBatches: number } | null;
  commits: Array<{ sha: string; message: string; committedAt: string; branch: string | null; author: string; matchType: string; confidence: number }>;
  tasks: Array<{ id: string; title: string; progressState: string; intent: { id: string; title: string } | null }>;
}
export interface CloudSessionEvent {
  id: string; parentEventId: string | null; sequence: number; type: string; status: string; startedAt: string;
  prompt: string | null; response: string | null; reasoning: string | null; tool: { name: string | null; input: string | null; output: string | null } | null;
  files: string[]; git: { branch: string | null; commitSha: string | null } | null; error: unknown; truncated: string[];
}
export interface CloudSessionEvents { sessionId: string; section: { sequence: number; title: string } | null; events: CloudSessionEvent[]; total: number; nextOffset: number | null; maxChars: number }
export interface CloudContextLink { createdAt: string; expiresAt: string; revokedAt: string | null }
export interface CloudContextLinkResult { sessionId: string; created?: boolean; action?: string; active?: boolean; link: CloudContextLink | null; url: string | null; serverNow: string }
export interface CloudCommitExplanation {
  commit: { sha: string; message: string; author: { name: string; email: string }; committedAt: string; branch: string | null; projects: Array<{ id: string; name: string | null }> };
  attributions: Array<{
    session: { id: string; title: string | null; platform: string; startedAt: string; user: CloudPerson | null };
    matchType: string; confidence: number;
    prompt: { at: string; text: string | null; truncated: boolean } | null;
    response: { at: string; text: string | null; truncated: boolean } | null;
    outlineSections: Array<{ sequence: number; title: string }>;
  }>;
  note: string;
}
export interface CloudUsageTotals { requests: number; pricedRequests: number; unpricedRequests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd: string | null; models: string[] }
export interface CloudUsage { period: CloudPeriod; scope: { kind: string; team: { id: string; name: string; role: CloudRole } | null; member: CloudPerson | null; projectId: string | null }; by: string; totals: CloudUsageTotals; rows: Array<Omit<CloudUsageTotals, "models"> & { key: string; label: string }>; unreadableSessions: number }
export interface CloudDailyReport {
  team: { id: string; name: string; role: CloudRole }; member: CloudPerson; workDate: string; state: "generated" | "generating" | "failed" | "pending" | "none"; generatedAt: string | null; error: string | null;
  cards: Array<{ cardId: string; title: string; stage: string; stageReason: string | null; contribution: string; evidence: Array<{ kind: string; title: string | null; at: string; sessionId: string | null; commitSha: string | null }> }>;
  gaps: unknown;
}
export interface CloudTeamMembers { team: { id: string; name: string }; viewer: { id: string; role: CloudRole; canQueryOthers: boolean }; members: Array<CloudPerson & { role: CloudRole; projectCount: number }> }
export interface CloudTeamProgress {
  team: { id: string; name: string; role: CloudRole }; member: CloudPerson & { role: CloudRole }; query: string | null; period: CloudPeriod;
  tasks: Array<{ id: string; title: string; progressState: string; priority: string; dueAt: string | null; startAt: string | null; updatedAt: string; intent: { id: string; title: string } | null }>;
  sessions: Array<{ id: string; project: { id: string; name: string | null }; startedAt: string; lastActivityAt: string; sections: Array<{ sequence: number; title: string }> }>;
  cards: Array<{ cardId: string; title: string; stage: string; contribution: string | null; evidence: Array<{ kind: string; title: string | null; at: string; sessionId: string | null; commitSha: string | null }> }>;
  commits: Array<{ sha: string; message: string; committedAt: string; branch: string | null }>;
}

const id = encodeURIComponent;

export function listCloudProjects(client: CloudClient, input: { q?: string | null; kind?: string | null } = {}): Promise<{ projects: CloudProject[] }> {
  return client.get(`/api/cli/projects${query(input)}`);
}
export function listCloudTeams(client: CloudClient): Promise<{ teams: CloudTeam[] }> {
  return client.get("/api/cli/teams");
}
export function listCloudTeamMembers(client: CloudClient, teamId: string): Promise<CloudTeamMembers> {
  return client.get(`/api/cli/teams/${id(teamId)}/members`);
}
export function cloudTeamProgress(client: CloudClient, teamId: string, input: { member: string; q?: string | null } & CloudPeriodParams): Promise<CloudTeamProgress> {
  return client.get(`/api/cli/teams/${id(teamId)}/progress${query(input)}`);
}
export function listCloudSessions(client: CloudClient, input: CloudScopeParams & CloudPeriodParams & CloudPageParams): Promise<CloudSessionList> {
  return client.get(`/api/cli/sessions${query(input)}`);
}
export function searchCloudSessions(client: CloudClient, input: { q: string } & CloudScopeParams & CloudPeriodParams & CloudPageParams): Promise<CloudSessionSearch> {
  return client.get(`/api/cli/sessions/search${query(input)}`);
}
export function showCloudSession(client: CloudClient, sessionId: string): Promise<CloudSessionDetail> {
  return client.get(`/api/cli/sessions/${id(sessionId)}`);
}
export function readCloudSessionEvents(client: CloudClient, sessionId: string, input: { section?: number | null; types?: string | null; maxChars?: number | null } & CloudPageParams): Promise<CloudSessionEvents> {
  return client.get(`/api/cli/sessions/${id(sessionId)}/events${query(input)}`);
}
export function cloudSessionLink(client: CloudClient, sessionId: string, action: "status" | "create" | "renew" | "revoke"): Promise<CloudContextLinkResult> {
  const path = `/api/cli/sessions/${id(sessionId)}/context-link`;
  if (action === "create") return client.post(path, {});
  if (action === "renew") return client.patch(path, {});
  if (action === "revoke") return client.delete<CloudContextLinkResult>(path);
  return client.get(path);
}
export function explainCloudCommit(client: CloudClient, sha: string, input: { project?: string | null } = {}): Promise<CloudCommitExplanation> {
  return client.get(`/api/cli/commits/${id(sha)}${query(input)}`);
}
export function cloudUsage(client: CloudClient, input: { scope?: string | null; by?: string | null } & CloudScopeParams & CloudPeriodParams): Promise<CloudUsage> {
  return client.get(`/api/cli/usage${query(input)}`);
}
export function cloudDailyReports(client: CloudClient, input: { date?: string | null; team?: string | null; member?: string | null } & CloudPeriodParams): Promise<{ period: CloudPeriod; reports: CloudDailyReport[] }> {
  return client.get(`/api/cli/reports/daily${query(input)}`);
}
