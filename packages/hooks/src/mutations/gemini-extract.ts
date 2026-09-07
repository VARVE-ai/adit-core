/**
 * Gemini CLI transcript JSONL → AgentFileMutation[].
 *
 * Gemini writes session transcripts to ~/.gemini/tmp/<project>/chats/<session>.jsonl
 * Each line is a JSON entry with `type` of "main" / "user" / "gemini" / etc.
 *
 * File-edit evidence lives inside `gemini` entries under `toolCalls[]`:
 *   - name: "replace" | "write_file" | "edit" | "insert"
 *   - args.file_path: target file
 *   - status: "success" | other
 *   - resultDisplay.fileDiff: ready-made unified diff (when available)
 *
 * Turn boundary: a real user prompt has `type === "user"` with non-empty text content.
 */

import { readFileSync, existsSync } from "node:fs";
import type { AgentFileMutation, MutationKind, MutationSource } from "./types.js";
import { MAX_FILE_BYTES, MAX_FILE_DIFF_BYTES, utf8ByteLength } from "./constants.js";

const GEMINI_FILE_EDIT_TOOLS = new Set(["write_file", "replace", "edit", "insert"]);

interface RawEntry {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  content?: unknown;
  toolCalls?: unknown;
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  status?: string;
  resultDisplay?: { fileDiff?: unknown } | null;
}

export interface ExtractResult {
  mutations: AgentFileMutation[];
}

export function extractGeminiMutationsFromTranscript(
  transcriptPath: string,
): ExtractResult | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const text = readFileSync(transcriptPath, "utf8");
  const entries: RawEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as RawEntry);
    } catch {
      // skip malformed
    }
  }
  if (entries.length === 0) return null;

  const bounds = findLatestTurnBounds(entries);
  const mutations: AgentFileMutation[] = [];

  for (let i = bounds.start; i < bounds.end; i++) {
    const e = entries[i];
    if (e?.type !== "gemini") continue;
    if (!Array.isArray(e.toolCalls)) continue;
    for (const call of e.toolCalls) {
      const tc = call as GeminiToolCall;
      if (!tc || typeof tc.name !== "string") continue;
      if (!GEMINI_FILE_EDIT_TOOLS.has(tc.name)) continue;
      const m = buildMutation(tc);
      if (m) mutations.push(m);
    }
  }

  return {
    mutations,
  };
}

function findLatestTurnBounds(entries: RawEntry[]): { start: number; end: number } {
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealPrompt(entries[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) start = 0;
  return { start, end: entries.length };
}

function isRealPrompt(entry: RawEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.content;
  if (!Array.isArray(content)) return false;
  return content.some((c) => {
    if (!c || typeof c !== "object") return false;
    const t = (c as { text?: unknown }).text;
    return typeof t === "string" && t.trim().length > 0;
  });
}

function buildMutation(tc: GeminiToolCall): AgentFileMutation | null {
  const args = tc.args ?? {};
  const rawPath = args.file_path ?? args.path ?? args.filePath;
  if (typeof rawPath !== "string") return null;
  const path = rawPath.replace(/\\/g, "/");

  const toolName = tc.name ?? "?";
  const isSuccess = tc.status === "success";
  const status = isSuccess ? "completed" : "failed";

  const m: AgentFileMutation = {
    provider: "gemini",
    toolUseId: tc.id ?? `gemini-${toolName}`,
    toolName,
    path,
    kind: kindForTool(toolName),
    status,
    source: sourceForTool(toolName),
  };

  if (!isSuccess) {
    m.omitted = { reason: "failed" };
    return m;
  }

  // Source file size guard (use args.content / args.new_string as proxy)
  const approxBytes = largestArgBytes(args);
  if (approxBytes > MAX_FILE_BYTES) {
    m.omitted = {
      reason: "file_too_large",
      bytes: approxBytes,
      limitBytes: MAX_FILE_BYTES,
    };
    return m;
  }

  // Preferred path: Gemini hands us a ready-made fileDiff
  const fileDiff = tc.resultDisplay?.fileDiff;
  if (typeof fileDiff === "string" && fileDiff.length > 0) {
    const diff = normalizeGeminiFileDiff(fileDiff);
    if (utf8ByteLength(diff) > MAX_FILE_DIFF_BYTES) {
      m.omitted = {
        reason: "diff_too_large",
        bytes: utf8ByteLength(diff),
        limitBytes: MAX_FILE_DIFF_BYTES,
      };
      return m;
    }
    assignStats(m, diff);
    m.diff = diff;
    return m;
  }

  // Fallback: synthesize pure additions from write_file content
  if (toolName === "write_file" && typeof args.content === "string") {
    const diff = wholeFileAdditionsDiff(args.content);
    if (utf8ByteLength(diff) > MAX_FILE_DIFF_BYTES) {
      m.omitted = {
        reason: "diff_too_large",
        bytes: utf8ByteLength(diff),
        limitBytes: MAX_FILE_DIFF_BYTES,
      };
      return m;
    }
    assignStats(m, diff);
    m.diff = diff;
    return m;
  }

  // Fallback: synthesize diff from replace args (old_string → new_string)
  if (
    toolName === "replace" &&
    typeof args.old_string === "string" &&
    typeof args.new_string === "string"
  ) {
    const diff = synthesizeReplaceDiff(args.old_string, args.new_string);
    if (utf8ByteLength(diff) > MAX_FILE_DIFF_BYTES) {
      m.omitted = {
        reason: "diff_too_large",
        bytes: utf8ByteLength(diff),
        limitBytes: MAX_FILE_DIFF_BYTES,
      };
      return m;
    }
    assignStats(m, diff);
    m.diff = diff;
    return m;
  }

  m.omitted = { reason: "unavailable" };
  return m;
}

function kindForTool(toolName: string): MutationKind {
  if (toolName === "write_file") return "update"; // could be add or update; default update
  return "update";
}

function sourceForTool(toolName: string): MutationSource {
  if (toolName === "write_file") return "gemini-write-file";
  if (toolName === "replace") return "gemini-replace";
  if (toolName === "edit") return "gemini-edit";
  if (toolName === "insert") return "gemini-insert";
  return "gemini-replace";
}

// Strip Gemini's SVN-style header so downstream sees standard unified diff.
// Input format:
//   Index: <file>
//   ===================================================================
//   --- <file>\tCurrent
//   +++ <file>\tProposed
//   @@ -X,Y +A,B @@
//    context
//   -old
//   +new
// Output keeps @@ hunks and body, drops Index/=== lines and tab-suffixes.
function normalizeGeminiFileDiff(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("Index:")) continue;
    if (/^=+$/.test(line)) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // strip trailing tab+suffix (e.g. "file.md\tCurrent")
      out.push(line.split("\t")[0]);
      continue;
    }
    out.push(line);
  }
  // trim leading/trailing empty lines
  return out.join("\n").trim();
}

function wholeFileAdditionsDiff(content: string): string {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out = [`@@ -0,0 +1,${lines.length} @@`];
  for (const l of lines) out.push("+" + l);
  return out.join("\n");
}

function synthesizeReplaceDiff(oldString: string, newString: string): string {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const out = [`@@ -1,${oldLines.length} +1,${newLines.length} @@`];
  for (const l of oldLines) out.push("-" + l);
  for (const l of newLines) out.push("+" + l);
  return out.join("\n");
}

function largestArgBytes(args: Record<string, unknown>): number {
  let max = 0;
  for (const key of ["content", "new_string", "old_string"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > max) max = v.length;
  }
  return max;
}

function assignStats(m: AgentFileMutation, diff: string): void {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  m.additions = additions;
  m.deletions = deletions;
}
