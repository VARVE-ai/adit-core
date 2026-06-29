/**
 * Build FileStat[] JSON for events.diff_stat_json from mutations.
 *
 * Status mapping matches existing FileStat union (M | A | D | R | "??").
 */

import type { AgentFileMutation, MutationKind } from "./types.js";

type FileStatus = "M" | "A" | "D" | "R" | "??";

export interface DiffStatEntry {
  path: string;
  status: FileStatus;
  additions?: number;
  deletions?: number;
  omitted?: { reason: string; bytes?: number; limitBytes?: number };
  toolName?: string;
  source?: string;
}

function statusFromKind(kind: MutationKind): FileStatus {
  switch (kind) {
    case "add": return "A";
    case "update": return "M";
    case "delete": return "D";
    case "rename": return "R";
    default: return "??";
  }
}

export function buildDiffStat(mutations: AgentFileMutation[]): DiffStatEntry[] {
  return mutations.map((m) => {
    const entry: DiffStatEntry = {
      path: m.path,
      status: statusFromKind(m.kind),
    };
    if (typeof m.additions === "number") entry.additions = m.additions;
    if (typeof m.deletions === "number") entry.deletions = m.deletions;
    if (m.omitted) {
      entry.omitted = {
        reason: m.omitted.reason,
        ...(m.omitted.bytes !== undefined ? { bytes: m.omitted.bytes } : {}),
        ...(m.omitted.limitBytes !== undefined ? { limitBytes: m.omitted.limitBytes } : {}),
      };
    }
    entry.toolName = m.toolName;
    entry.source = m.source;
    return entry;
  });
}
