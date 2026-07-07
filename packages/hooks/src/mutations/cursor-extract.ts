/**
 * Cursor IDE transcript JSONL → AgentFileMutation[].
 *
 * Cursor stores transcripts at:
 *   ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<session>/<session>.jsonl
 *
 * Structure (per real样本 inspection):
 *   - Entries have `role` of "user" | "assistant"
 *   - Turn boundaries marked by standalone `{"type":"turn_ended","status":"success"}` entries
 *   - assistant.content[] contains tool_use blocks inline:
 *       Write:       { input: { path, contents } }
 *       StrReplace:  { input: { path, old_string, new_string } }
 *   - **No tool_result / toolUseResult in transcript.** Status is inferred from turn_ended.
 *
 * Because Cursor doesn't expose tool results, diffs are synthesized from input args:
 *   - Write      → whole-file additions
 *   - StrReplace → "-" old lines + "+" new lines (no surrounding context)
 */

import { readFileSync, existsSync } from "node:fs";
import type { AgentFileMutation, MutationKind, MutationSource } from "./types.js";
import { MAX_FILE_BYTES, MAX_FILE_DIFF_BYTES } from "./constants.js";
import { transcriptEntryRole } from "../common/transcript-entry.js";

const CURSOR_FILE_EDIT_TOOLS = new Set(["Write", "StrReplace", "Edit", "Overwrite"]);

interface RawEntry {
  role?: string;
  type?: string;
  status?: string;
  message?: { content?: unknown };
}

interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  name: string;
  input?: Record<string, unknown>;
}

export interface ExtractResult {
  startedAt: string | undefined;
  endedAt: string | undefined;
  mutations: AgentFileMutation[];
}

export function extractCursorMutationsFromTranscript(
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
  const turnStatus = findLatestTurnStatus(entries, bounds);

  const mutations: AgentFileMutation[] = [];
  let toolIndex = 0;
  for (let i = bounds.start; i < bounds.end; i++) {
    const e = entries[i];
    if (!e || transcriptEntryRole(e) !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!isToolUseBlock(blk)) continue;
      if (!CURSOR_FILE_EDIT_TOOLS.has(blk.name)) continue;
      // Cursor tool_use blocks have no `id`; synthesize one for dedup downstream.
      const id = blk.id ?? `cursor-${blk.name}-${toolIndex++}`;
      const m = buildMutation({ ...blk, id }, turnStatus);
      if (m) mutations.push(m);
    }
  }

  return {
    startedAt: undefined,
    endedAt: undefined,
    mutations,
  };
}

// Cursor's turn boundary is marked by standalone `{"type":"turn_ended",...}`
// entries. The latest turn = [after previous turn_ended] → [next turn_ended].
// If the transcript is mid-turn (no final turn_ended), fall back to
// [last user entry] → EOF.
function findLatestTurnBounds(entries: RawEntry[]): { start: number; end: number } {
  // Find last turn_ended index
  let lastEnd = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "turn_ended") {
      lastEnd = i;
      break;
    }
  }

  // No completed turn yet — use last user → EOF
  if (lastEnd === -1) {
    let start = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry && transcriptEntryRole(entry) === "user") {
        start = i;
        break;
      }
    }
    return { start: start === -1 ? 0 : start, end: entries.length };
  }

  // Find previous turn_ended to bound the start
  let prevEnd = -1;
  for (let i = lastEnd - 1; i >= 0; i--) {
    if (entries[i]?.type === "turn_ended") {
      prevEnd = i;
      break;
    }
  }

  return {
    start: prevEnd + 1, // include everything after previous turn_ended
    end: lastEnd + 1,   // include the closing turn_ended itself
  };
}

function findLatestTurnStatus(
  entries: RawEntry[],
  bounds: { start: number; end: number },
): "success" | "failed" | "unknown" {
  for (let i = bounds.end - 1; i >= bounds.start; i--) {
    const e = entries[i];
    if (e?.type === "turn_ended") {
      if (e.status === "success") return "success";
      if (e.status && e.status !== "success") return "failed";
    }
  }
  return "unknown";
}

function isToolUseBlock(b: unknown): b is ToolUseBlock {
  return (
    !!b &&
    typeof b === "object" &&
    (b as { type?: string }).type === "tool_use" &&
    typeof (b as { name?: unknown }).name === "string"
  );
}

function buildMutation(
  blk: ToolUseBlock,
  turnStatus: "success" | "failed" | "unknown",
): AgentFileMutation | null {
  const input = blk.input ?? {};
  const rawPath = input.path ?? input.file_path ?? input.target_file;
  if (typeof rawPath !== "string") return null;
  const path = rawPath.replace(/\\/g, "/");

  const toolName = blk.name;
  // Cursor transcript has no per-tool result; infer from turn-level status.
  const status: "completed" | "failed" =
    turnStatus === "failed" ? "failed" : "completed";

  const m: AgentFileMutation = {
    provider: "cursor",
    toolUseId: blk.id ?? `cursor-${toolName}`,
    toolName,
    path,
    kind: kindForTool(toolName),
    status,
    source: sourceForTool(toolName),
  };

  // Source-file size guard
  const approxBytes = largestInputBytes(input);
  if (approxBytes > MAX_FILE_BYTES) {
    m.omitted = {
      reason: "file_too_large",
      bytes: approxBytes,
      limitBytes: MAX_FILE_BYTES,
    };
    return m;
  }

  // Write: synthesize pure-additions diff from contents
  if (toolName === "Write" || toolName === "Overwrite") {
    const contents = input.contents ?? input.content;
    if (typeof contents === "string") {
      const diff = wholeFileAdditionsDiff(contents);
      return finalizeWithCap(m, diff);
    }
  }

  // StrReplace: synthesize diff from old_string → new_string
  if (toolName === "StrReplace" || toolName === "Edit") {
    const oldStr = input.old_string;
    const newStr = input.new_string;
    if (typeof oldStr === "string" && typeof newStr === "string") {
      const diff = synthesizeReplaceDiff(oldStr, newStr);
      return finalizeWithCap(m, diff);
    }
  }

  m.omitted = { reason: "unavailable" };
  return m;
}

function kindForTool(_toolName: string): MutationKind {
  // Cursor Write can either create or overwrite — without tool_result we can't
  // tell which. Default to "update" for safety; "add" would be wrong for
  // overwrites and only mildly misleading for creates.
  return "update";
}

function sourceForTool(toolName: string): MutationSource {
  if (toolName === "Write" || toolName === "Overwrite") return "cursor-write";
  if (toolName === "StrReplace" || toolName === "Edit") return "cursor-strreplace";
  return "cursor-write";
}

function finalizeWithCap(m: AgentFileMutation, diff: string): AgentFileMutation {
  if (diff.length > MAX_FILE_DIFF_BYTES) {
    m.omitted = {
      reason: "diff_too_large",
      bytes: diff.length,
      limitBytes: MAX_FILE_DIFF_BYTES,
    };
    return m;
  }
  assignStats(m, diff);
  m.diff = diff;
  return m;
}

function wholeFileAdditionsDiff(content: string): string {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out = [`@@ -0,0 +1,${lines.length} @@`];
  for (const l of lines) out.push("+" + l);
  return out.join("\n");
}

function synthesizeReplaceDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  // Note: this is an approximate diff — only the changed lines, no surrounding
  // context. Cursor transcript doesn't expose original file content so we
  // cannot reconstruct full context. The additions/deletions counts are exact.
  const out = [`@@ -1,${oldLines.length} +1,${newLines.length} @@`];
  for (const l of oldLines) out.push("-" + l);
  for (const l of newLines) out.push("+" + l);
  return out.join("\n");
}

function largestInputBytes(input: Record<string, unknown>): number {
  let max = 0;
  for (const key of ["contents", "content", "old_string", "new_string"]) {
    const v = input[key];
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
