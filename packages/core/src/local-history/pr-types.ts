export type PrOptions = {
  detail: "brief" | "detailed" | "project-template"; language: "en" | "zh";
  sessions: boolean; lines: boolean; assistedBy: boolean; prompts: boolean; shareLinks: boolean; aditLabel: boolean;
  template?: string; title?: string;
};
export const defaultPrOptions: PrOptions = { detail: "detailed", language: "en", sessions: true, lines: true, assistedBy: true, prompts: false, shareLinks: false, aditLabel: true };
export type PrScopeCommit = { sha: string; subject: string; included: boolean; reason: "merge" | "other-author" | null };
export type PrScope = {
  repository: string; kind: "branches" | "commits"; head: string | null; base: string | null;
  headSha: string | null; baseSha: string | null; mergeBase: string | null; author: string;
  commits: PrScopeCommit[]; digest: string;
};
export type PrLines = { eligible: number; excluded: number; certain: number; likely: number; possible: number; moved: number; unknown: number };
export type PrPerson = { provider: string; sessionId: string; number: number };
export type PrCommit = PrScopeCommit & {
  analysis: "done" | "pending" | "excluded"; submitter: (PrPerson & { turnId: string | null; method: string | null }) | null;
  writers: (PrPerson & { certain: number; likely: number; possible: number })[]; lines: PrLines | null;
  alternatives: { provider: string; sessionId: string; certain: number; likely: number; possible: number }[];
};
export type PrSession = PrPerson & { agent: string; date: number | null; prompts: number | null; duration: number | null; models: string[]; rangeModels: string[]; contextIncluded?: boolean };
export type PrDescription = {
  id: string; title: string; createdAt: number; scope: PrScope; options: PrOptions; markdown: string;
  commits: PrCommit[]; sessions: PrSession[];
  summary: { commits: number; sessions: number; unmatched: number; pending: number; excludedMerges: number; excludedAuthors: number; lines: PrLines | null; prompts: number | null; duration: number | null };
  warnings: string[]; attributionVersion: number | null;
};
export type PrItem = { id: string; title: string; repository: string; source_ref: string | null; target_ref: string | null; created_at: number; detail_level: string; language: string; commit_count: number; session_count: number; unmatched_count: number };
