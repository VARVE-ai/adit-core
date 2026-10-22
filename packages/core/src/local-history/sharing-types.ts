export type ShareOptions = {
  scope: "all" | "selected";
  turnIds: string[];
  dialogue: boolean;
  commands: boolean;
  commits: boolean;
  outputs: boolean;
  thinking: boolean;
  cost: boolean;
  names: string[];
};
export const defaultShareOptions: ShareOptions = {
  scope: "all", turnIds: [], dialogue: true, commands: true, commits: true,
  outputs: false, thinking: false, cost: false, names: [],
};
export type SharedCommit = { sha: string; subject: string; repository: string; files: number; additions: number | null; deletions: number | null };
export type SharedEvent = { kind: "reply" | "command" | "output" | "thinking"; text: string; name?: string; summary?: string; icon?: string };
export type SharedTurn = {
  prompt?: string;
  models: string[]; efforts: string[];
  input: number | null; output: number | null; cache: number | null;
  events: SharedEvent[]; commits: SharedCommit[];
};
/** Public allowlist: no native ids, source paths, raw metadata, options or audit records. */
export type ShareSnapshot = {
  schemaVersion: 1; title: string; agent: string; provider: string; models: string[];
  date: number | null; promptCount: number; commitCount: number; commandCount: number;
  turns: SharedTurn[]; commits: SharedCommit[]; costMicrousd?: number | null; costIncomplete?: boolean;
};
export type ShareItem = {
  id: string; title: string; provider: string; status: string; published_at: number | null;
  created_at: number; remote_url: string | null; viewer_url: string | null; prompt_count: number; commit_count: number;
};
export type ShareDraft = {
  provider: string; sessionId: string;
  id: string; version: string; sourceRevision: number; digest: string; status: string;
  options: ShareOptions; snapshot: ShareSnapshot; markdown: string;
  turns: { id: string; ordinal: number; prompt: string }[];
  redactions: Record<string, number>; excludedCategories: number; memoryActions: number;
  gistConfigured?: boolean; error?: string;
};
