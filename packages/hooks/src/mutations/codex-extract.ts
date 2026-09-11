/**
 * Codex transcript JSONL -> AgentFileMutation[].
 *
 * Every apply_patch Codex performs is recorded as an `item_completed` event
 * whose item has `type: "FileChange"`: one entry per file with its unified
 * diff (or the full content for added/deleted files) and the outcome. The
 * record exists in the 0.151 and 0.153 transcript formats alike, so it is the
 * only source read here. Shell-driven edits are not represented.
 */

import { existsSync, readFileSync } from "node:fs";
import type { AgentFileMutation, MutationKind } from "./types.js";
import { MAX_FILE_BYTES, MAX_FILE_DIFF_BYTES, utf8ByteLength } from "./constants.js";

interface CodexRawEntry {
  type?: string;
  timestamp?: string;
  payload?: unknown;
}

interface CodexExtractResult {
  mutations: AgentFileMutation[];
}

interface CodexFileChangeItem extends Record<string, unknown> {
  type: "FileChange";
  id?: string;
  status?: string;
  changes?: unknown;
}

interface CodexPatchChange {
  type?: string;
  unified_diff?: string;
  content?: string;
  move_path?: string | null;
}

export function extractCodexMutationsFromTranscript(
  transcriptPath: string,
): CodexExtractResult | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const entries = readTranscriptEntries(transcriptPath);
  if (entries.length === 0) return null;

  const turnBounds = findLatestTurnBounds(entries);
  const mutations: AgentFileMutation[] = [];

  for (let index = turnBounds.start; index < turnBounds.end; index++) {
    const item = fileChangeItem(entries[index]?.payload);
    if (item) mutations.push(...mutationsFromFileChange(item));
  }

  return {
    mutations,
  };
}

function readTranscriptEntries(transcriptPath: string): CodexRawEntry[] {
  const text = readFileSync(transcriptPath, "utf8");
  const entries: CodexRawEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (asRecord(parsed)) entries.push(parsed as CodexRawEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function findLatestTurnBounds(entries: CodexRawEntry[]): { start: number; end: number } {
  let start = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (isUserPrompt(entries[index])) {
      start = index;
      break;
    }
  }
  if (start === -1) start = 0;
  return { start, end: entries.length };
}

function isUserPrompt(entry: CodexRawEntry | undefined): boolean {
  const payload = asRecord(entry?.payload);
  if (!payload) return false;
  if (payload.type !== "message" || payload.role !== "user") return false;
  const content = payload.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    if (typeof item === "string") return item.trim().length > 0;
    const record = asRecord(item);
    if (!record) return false;
    return (
      record.type === "input_text" ||
      record.type === "input_image" ||
      record.type === "input_file"
    );
  });
}

function fileChangeItem(payload: unknown): CodexFileChangeItem | null {
  const record = asRecord(payload);
  if (record?.type !== "item_completed") return null;
  const item = asRecord(record.item);
  return item?.type === "FileChange" ? item as CodexFileChangeItem : null;
}

function mutationsFromFileChange(item: CodexFileChangeItem): AgentFileMutation[] {
  const changes = asRecord(item.changes);
  if (!changes) return [];

  const mutations: AgentFileMutation[] = [];
  const toolUseId = readString(item.id) ?? "codex-file-change";
  const isSuccess = item.status === "completed" || item.status === "success";
  const status = isSuccess ? "completed" : "failed";

  for (const [rawPath, rawChange] of Object.entries(changes)) {
    const change = asRecord(rawChange) as CodexPatchChange | null;
    if (!change) continue;
    const path = normalizePath(rawPath);
    const mutation: AgentFileMutation = {
      provider: "codex",
      toolUseId,
      toolName: "apply_patch",
      path,
      kind: kindFromCodexChange(change),
      status,
      source: "codex-file-change",
    };

    if (!isSuccess) {
      mutation.omitted = { reason: "failed" };
      mutations.push(mutation);
      continue;
    }

    // Added/deleted files carry their full content, which doubles as the file
    // size guard. Updates only expose the unified diff, so the diff-size check
    // below is the only cap that applies to them.
    const contentField = typeof change.content === "string" ? change.content : "";
    if (utf8ByteLength(contentField) > MAX_FILE_BYTES) {
      mutation.omitted = {
        reason: "file_too_large",
        bytes: utf8ByteLength(contentField),
        limitBytes: MAX_FILE_BYTES,
      };
      mutations.push(mutation);
      continue;
    }

    const diff = diffFromCodexChange(path, change);
    if (diff) {
      if (utf8ByteLength(diff) > MAX_FILE_DIFF_BYTES) {
        mutation.omitted = {
          reason: "diff_too_large",
          bytes: utf8ByteLength(diff),
          limitBytes: MAX_FILE_DIFF_BYTES,
        };
      } else {
        assignStats(mutation, diff);
        mutation.diff = diff;
      }
    } else {
      mutation.omitted = { reason: "unavailable" };
    }

    mutations.push(mutation);
  }

  return mutations;
}

function diffFromCodexChange(path: string, change: CodexPatchChange): string | null {
  if (typeof change.unified_diff === "string" && change.unified_diff.length > 0) {
    return change.unified_diff;
  }
  if (change.type === "add" && typeof change.content === "string") {
    return wholeFileAdditionsDiff(change.content);
  }
  if (change.type === "delete" && typeof change.content === "string") {
    return wholeFileDeletionsDiff(change.content);
  }
  if (
    change.type === "rename" &&
    typeof change.move_path === "string" &&
    change.move_path.length > 0
  ) {
    return `rename from ${normalizePath(change.move_path)}\nrename to ${path}`;
  }
  return null;
}

function kindFromCodexChange(change: CodexPatchChange): MutationKind {
  if (change.type === "add") return "add";
  if (change.type === "delete") return "delete";
  if (change.type === "rename") return "rename";
  return "update";
}

function wholeFileAdditionsDiff(content: string): string {
  const lines = splitContentLines(content);
  const out = [`@@ -0,0 +1,${lines.length} @@`];
  for (const line of lines) out.push(`+${line}`);
  return out.join("\n");
}

function wholeFileDeletionsDiff(content: string): string {
  const lines = splitContentLines(content);
  const out = [`@@ -1,${lines.length} +0,0 @@`];
  for (const line of lines) out.push(`-${line}`);
  return out.join("\n");
}

function splitContentLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function assignStats(mutation: AgentFileMutation, diff: string): void {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  mutation.additions = additions;
  mutation.deletions = deletions;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
