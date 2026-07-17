/**
 * Claude Code transcript JSONL → AgentFileMutation[].
 *
 * Reads `~/.claude/projects/<encoded-cwd>/<session>.jsonl`, splits into turns,
 * and extracts file-edit mutations from the latest turn (or all turns).
 *
 * Verified field structure (from 60+ real session samples):
 *   - assistant.content[].tool_use with name in {Write, Edit, MultiEdit, NotebookEdit}
 *   - user.toolUseResult (top-level on the user line, NOT in message.content):
 *     { type, filePath, content, structuredPatch, originalFile, userModified }
 *   - NotebookEdit toolUseResult has a different shape:
 *     { new_source, cell_type, language, edit_mode, cell_id, error,
 *       notebook_path, original_file, updated_file }
 */

import { readFileSync, existsSync } from "node:fs";
import type { AgentFileMutation, MutationKind, MutationSource } from "./types.js";
import { MAX_FILE_BYTES, MAX_FILE_DIFF_BYTES, MAX_EVENT_DIFF_BYTES, utf8ByteLength } from "./constants.js";

const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

interface RawEntry {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  toolUseResult?: Record<string, unknown> | null;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content?: unknown;
}

export interface ExtractResult {
  sessionId: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  mutations: AgentFileMutation[];
}

export function extractClaudeMutationsFromTranscript(
  transcriptPath: string,
  options?: { provider?: "claude-code" | "claude-vscode" },
): ExtractResult | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const provider = options?.provider ?? "claude-code";
  const text = readFileSync(transcriptPath, "utf8");
  const entries: RawEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as RawEntry);
    } catch {
      // skip malformed lines
    }
  }
  if (entries.length === 0) return null;

  const toolResults = indexToolResults(entries);
  const turnBounds = findLatestTurnBounds(entries);

  const mutations: AgentFileMutation[] = [];
  for (let i = turnBounds.start; i < turnBounds.end; i++) {
    const e = entries[i];
    if (e?.type !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!isToolUseBlock(blk)) continue;
      if (!FILE_EDIT_TOOLS.has(blk.name)) continue;
      const result = toolResults.get(blk.id);
      const m = buildMutation(blk, result, provider);
      if (m) mutations.push(m);
    }
  }

  return {
    sessionId: entries[0]?.sessionId,
    startedAt: entries[turnBounds.start]?.timestamp,
    endedAt: entries[turnBounds.end - 1]?.timestamp,
    mutations,
  };
}

function indexToolResults(entries: RawEntry[]): Map<string, { isError: boolean; tur: Record<string, unknown> | null }> {
  const map = new Map<string, { isError: boolean; tur: Record<string, unknown> | null }>();
  for (const e of entries) {
    if (e?.type !== "user") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!isToolResultBlock(blk)) continue;
      map.set(blk.tool_use_id, {
        isError: blk.is_error === true,
        tur: e.toolUseResult ?? null,
      });
    }
  }
  return map;
}

// A user entry is a "real prompt" (not a tool_result forwarder) when its content
// is a string OR an array containing at least one non-tool_result block.
function isRealPrompt(entry: RawEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(
      (b) =>
        b &&
        typeof b === "object" &&
        (b as { type?: string }).type !== "tool_result" &&
        (b as { type?: string }).type !== "tool_use",
    );
  }
  return false;
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

function isToolUseBlock(b: unknown): b is ToolUseBlock {
  return (
    !!b &&
    typeof b === "object" &&
    (b as { type?: string }).type === "tool_use" &&
    typeof (b as { id?: unknown }).id === "string" &&
    typeof (b as { name?: unknown }).name === "string"
  );
}

function isToolResultBlock(b: unknown): b is ToolResultBlock {
  return (
    !!b &&
    typeof b === "object" &&
    (b as { type?: string }).type === "tool_result" &&
    typeof (b as { tool_use_id?: unknown }).tool_use_id === "string"
  );
}

function extractPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const raw =
    input.file_path ?? input.notebook_path ?? input.filePath ?? input.path;
  if (typeof raw !== "string") return undefined;
  // Normalize Windows backslashes to forward slashes so stored paths and diff
  // headers are platform-agnostic. We don't try to convert drive letters or
  // absolute roots — the goal is just consistency in storage, not path
  // remapping. Both POSIX and Windows originals survive a round-trip.
  return raw.replace(/\\/g, "/");
}

// Approximate source file size from whichever content-bearing field the
// toolUseResult happens to expose. We never read the file from disk — this
// is purely a JSONL-data heuristic for the file_too_large guard.
function largestContentBytes(tur: Record<string, unknown>): number {
  let max = 0;
  for (const key of ["content", "originalFile", "original_file", "updated_file"]) {
    const v = tur[key];
    if (typeof v === "string") {
      const bytes = utf8ByteLength(v);
      if (bytes > max) max = bytes;
    }
  }
  return max;
}

function kindForTool(
  toolName: string,
  tur: Record<string, unknown> | null,
  input: Record<string, unknown> | undefined,
): MutationKind {
  if (toolName === "Write") {
    if (tur?.type === "create") return "add";
    return "update";
  }
  if (toolName === "NotebookEdit") {
    const editMode = tur?.edit_mode ?? input?.edit_mode;
    if (editMode === "insert") return "add";
    return "update";
  }
  return "update";
}

function sourceForTool(toolName: string): MutationSource {
  switch (toolName) {
    case "Write": return "claude-write-tool";
    case "Edit": return "claude-edit-tool";
    case "MultiEdit": return "claude-multiedit-tool";
    case "NotebookEdit": return "claude-notebookedit-tool";
    default: return "claude-edit-tool";
  }
}

function buildMutation(
  blk: ToolUseBlock,
  result: { isError: boolean; tur: Record<string, unknown> | null } | undefined,
  provider: "claude-code" | "claude-vscode",
): AgentFileMutation | null {
  const path = extractPath(blk.input);
  if (!path) return null;

  const isError = result?.isError === true;
  const tur = result?.tur ?? null;
  const status = isError ? "failed" : "completed";

  const m: AgentFileMutation = {
    provider,
    toolUseId: blk.id,
    toolName: blk.name,
    path,
    kind: kindForTool(blk.name, tur, blk.input),
    status,
    source: sourceForTool(blk.name),
  };

  if (isError || !tur) {
    m.omitted = { reason: isError ? "failed" : "unavailable" };
    return m;
  }

  // Source file size check: if any available content proxy exceeds the file
  // byte cap, skip diff generation entirely. The mutation is still recorded
  // with path/kind/stat info but no diff body.
  const approxFileSize = largestContentBytes(tur);
  if (approxFileSize > MAX_FILE_BYTES) {
    m.omitted = {
      reason: "file_too_large",
      bytes: approxFileSize,
      limitBytes: MAX_FILE_BYTES,
    };
    return m;
  }

  // 1. structuredPatch (Edit/MultiEdit, sometimes Write-overwrite)
  const sp = tur.structuredPatch;
  if (Array.isArray(sp) && sp.length > 0) {
    const diff = structuredPatchToUnifiedDiff(sp as Array<Record<string, unknown>>);
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

  // 2. Write with full content (file create or overwrite with empty patch)
  if (blk.name === "Write" && typeof tur.content === "string") {
    const diff = wholeFileAdditionsDiff(tur.content);
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

  // 3. NotebookEdit (no structuredPatch; diff original_file vs updated_file)
  if (
    blk.name === "NotebookEdit" &&
    typeof tur.original_file === "string" &&
    typeof tur.updated_file === "string"
  ) {
    const diff = lineDiffUnified(tur.original_file, tur.updated_file);
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

function structuredPatchToUnifiedDiff(patches: Array<Record<string, unknown>>): string {
  const out: string[] = [];
  for (const p of patches) {
    const oldStart = p.oldStart as number | undefined;
    const oldLines = p.oldLines as number | undefined;
    const newStart = p.newStart as number | undefined;
    const newLines = p.newLines as number | undefined;
    out.push(`@@ -${oldStart ?? 0},${oldLines ?? 0} +${newStart ?? 0},${newLines ?? 0} @@`);
    const lines = p.lines;
    if (Array.isArray(lines)) {
      for (const l of lines) {
        if (typeof l === "string") out.push(l);
      }
    }
  }
  return out.join("\n");
}

function wholeFileAdditionsDiff(content: string): string {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out = [`@@ -0,0 +1,${lines.length} @@`];
  for (const l of lines) out.push("+" + l);
  return out.join("\n");
}

function lineDiffUnified(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const body: string[] = [];
  let hasChanges = false;
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      body.push(" " + a[i]); i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      body.push("-" + a[i]); hasChanges = true; i++;
    } else {
      body.push("+" + b[j]); hasChanges = true; j++;
    }
  }
  while (i < n) { body.push("-" + a[i]); hasChanges = true; i++; }
  while (j < m) { body.push("+" + b[j]); hasChanges = true; j++; }
  if (!hasChanges) return "";
  let oldLines = 0, newLines = 0;
  for (const l of body) {
    if (l.startsWith("-")) oldLines++;
    else if (l.startsWith("+")) newLines++;
    else { oldLines++; newLines++; }
  }
  return [`@@ -1,${oldLines} +1,${newLines} @@`, ...body].join("\n");
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

export const EVENT_DIFF_LIMIT = MAX_EVENT_DIFF_BYTES;
