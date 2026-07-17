/**
 * Codex transcript JSONL -> AgentFileMutation[].
 *
 * Codex writes patch application results as `event_msg` entries whose payload
 * has `type: "patch_apply_end"`. The reliable per-file evidence is in
 * `payload.changes`, not in the surrounding assistant/tool messages.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentFileMutation, MutationKind } from "./types.js";
import { MAX_FILE_BYTES, MAX_FILE_DIFF_BYTES, utf8ByteLength } from "./constants.js";

interface CodexRawEntry {
  type?: string;
  timestamp?: string;
  payload?: unknown;
}

interface CodexExtractResult {
  sessionId: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  mutations: AgentFileMutation[];
}

interface PatchApplyPayload extends Record<string, unknown> {
  type: "patch_apply_end";
  call_id?: string;
  status?: string;
  success?: boolean;
  changes?: unknown;
}

interface CodexPatchChange {
  type?: string;
  unified_diff?: string;
  content?: string;
  move_path?: string | null;
}

interface ExecCommandEndPayload extends Record<string, unknown> {
  type: "exec_command_end";
  call_id?: string;
  status?: string;
  exit_code?: number;
  cwd?: string;
  command?: unknown;
  parsed_cmd?: unknown;
}

interface ParsedCommand {
  type?: string;
  path?: unknown;
  cmd?: unknown;
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
    const payload = asRecord(entries[index]?.payload);
    if (isPatchApplyPayload(payload)) {
      mutations.push(...mutationsFromPatchApply(payload));
    } else if (isExecCommandEndPayload(payload)) {
      mutations.push(...mutationsFromExecCommandEnd(payload));
    }
  }

  return {
    sessionId: sessionIdFromPath(transcriptPath),
    startedAt: entries[turnBounds.start]?.timestamp,
    endedAt: entries[turnBounds.end - 1]?.timestamp,
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

function mutationsFromPatchApply(payload: PatchApplyPayload): AgentFileMutation[] {
  const changes = asRecord(payload.changes);
  if (!changes) return [];

  const mutations: AgentFileMutation[] = [];
  const toolUseId = readString(payload.call_id) ?? "codex-patch";
  const isSuccess = payload.success === true ||
    (payload.success !== false && payload.status === "completed");
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
      source: "codex-patch-apply-end",
    };

    if (!isSuccess) {
      mutation.omitted = { reason: "failed" };
      mutations.push(mutation);
      continue;
    }

    // Source file size check: when add/delete carries the full file content,
    // use it as a proxy for file size. Update-only entries only expose
    // unified_diff (no original-file snapshot), so we skip this guard for them
    // and let the diff-size check below catch any oversized payload.
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

function isPatchApplyPayload(value: Record<string, unknown> | null): value is PatchApplyPayload {
  return value?.type === "patch_apply_end";
}

function isExecCommandEndPayload(
  value: Record<string, unknown> | null,
): value is ExecCommandEndPayload {
  return value?.type === "exec_command_end";
}

interface ShellWriteTarget {
  path: string;
  kind: MutationKind;
}

function mutationsFromExecCommandEnd(payload: ExecCommandEndPayload): AgentFileMutation[] {
  if (!isSuccessfulExecCommand(payload)) return [];

  const toolUseId = readString(payload.call_id) ?? "codex-bash";
  const targets = extractWrittenPathsFromExecCommand(payload);
  return targets.map(({ path, kind }) => ({
    provider: "codex",
    toolUseId,
    toolName: "Bash",
    path,
    kind,
    status: "completed",
    source: "codex-bash-output",
    omitted: { reason: "unavailable" },
  }));
}

function isSuccessfulExecCommand(payload: ExecCommandEndPayload): boolean {
  if (payload.status === "completed") return true;
  return typeof payload.exit_code === "number" && payload.exit_code === 0;
}

function extractWrittenPathsFromExecCommand(payload: ExecCommandEndPayload): ShellWriteTarget[] {
  const targets = new Map<string, MutationKind>();
  const cwd = readString(payload.cwd);

  for (const command of readParsedCommands(payload.parsed_cmd)) {
    if (isReadOnlyParsedCommand(command)) continue;
    addTarget(targets, readString(command.path), cwd, "update");
  }

  const commandText = execCommandText(payload.command);
  if (commandText) {
    for (const target of extractShellWriteTargets(commandText)) {
      addTarget(targets, target.path, cwd, target.kind);
    }
  }

  return Array.from(targets, ([path, kind]) => ({ path, kind }));
}

function readParsedCommands(value: unknown): ParsedCommand[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item) as ParsedCommand | null)
    .filter((item): item is ParsedCommand => !!item);
}

function isReadOnlyParsedCommand(command: ParsedCommand): boolean {
  return command.type === "read" ||
    command.type === "list_files" ||
    command.type === "search";
}

function execCommandText(command: unknown): string | null {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return null;
  const parts = command.filter((part): part is string => typeof part === "string");
  if (parts.length === 0) return null;
  return parts.at(-1) ?? null;
}

function extractShellWriteTargets(command: string): ShellWriteTarget[] {
  const targets = new Map<string, MutationKind>();
  for (const line of command.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    extractRedirectionTargets(trimmed).forEach((path) => addTarget(targets, path, null, "update"));
    extractOptionTargets(trimmed).forEach((path) => addTarget(targets, path, null, "update"));
    extractKnownWriteCallTargets(trimmed).forEach((target) =>
      addTarget(targets, target.path, null, target.kind),
    );
  }
  return Array.from(targets, ([path, kind]) => ({ path, kind }));
}

function extractRedirectionTargets(command: string): string[] {
  const paths: string[] = [];
  const pattern = /(?:^|[\s;|&])(?:\d*)>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu;
  for (const match of command.matchAll(pattern)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path && isLikelyFilePath(path)) paths.push(path);
  }
  return paths;
}

function extractOptionTargets(command: string): string[] {
  const paths: string[] = [];
  const optionPattern = /(?:\s|^)(?:--out|--output)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu;
  for (const match of command.matchAll(optionPattern)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path && isPathLikeOptionTarget(path)) paths.push(path);
  }

  const shortOutputPattern =
    /\b(?:sips|curl)\b[^\n;&|]*\s-o\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu;
  for (const match of command.matchAll(shortOutputPattern)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path && isLikelyFilePath(path)) paths.push(path);
  }
  return paths;
}

function extractKnownWriteCallTargets(command: string): ShellWriteTarget[] {
  const targets: ShellWriteTarget[] = [];
  const updatePatterns = [
    /\bwriteFile(?:Sync)?\(\s*["']([^"']+)["']/gu,
    /\bPath\(\s*["']([^"']+)["']\s*\)\.write_(?:text|bytes)\(/gu,
    /\bopen\(\s*["']([^"']+)["']\s*,\s*["'][^"']*[wa][^"']*["']/gu,
    /\btouch\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu,
    // cp/mv record the written destination; mv's removed source is not
    // tracked by this heuristic.
    /\b(?:cp|mv)\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu,
  ];
  const deletePatterns = [
    /\b(?:rm|unlink)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu,
  ];

  const collect = (patterns: RegExp[], kind: MutationKind) => {
    for (const pattern of patterns) {
      for (const match of command.matchAll(pattern)) {
        const path = match.slice(1).find((value) => value);
        if (path && isLikelyFilePath(path)) targets.push({ path, kind });
      }
    }
  };
  collect(updatePatterns, "update");
  collect(deletePatterns, "delete");

  return targets;
}

function addTarget(
  targets: Map<string, MutationKind>,
  path: string | null,
  cwd: string | null,
  kind: MutationKind,
): void {
  if (!path || !isLikelyFilePath(path)) return;
  const absolutePath = cwd && !isAbsolute(path)
    ? resolve(join(cwd, path))
    : path;
  const normalized = normalizePath(absolutePath);
  // "delete" wins when one command both writes and removes a path — the
  // removal is the terminal state this heuristic can see.
  if (targets.get(normalized) === "delete") return;
  targets.set(normalized, kind);
}

function isLikelyFilePath(path: string): boolean {
  if (!path || path === "." || path === "..") return false;
  if (path.startsWith("-")) return false;
  if (path.includes("$(") || path.includes("`")) return false;
  if (path === "/dev/null" || /^&?\d+$/u.test(path)) return false;
  return true;
}

function isPathLikeOptionTarget(path: string): boolean {
  return isLikelyFilePath(path) &&
    (path.includes("/") || path.includes("\\") || path.includes("."));
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

function sessionIdFromPath(transcriptPath: string): string | undefined {
  return transcriptPath.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1];
}
