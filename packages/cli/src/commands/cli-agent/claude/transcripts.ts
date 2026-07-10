import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { asRecord, isUuid, readString } from "./sdk-messages.js";

export interface ClaudeRewindCheckpoint {
  messageId: string;
  label: string;
  preview: string;
  timestamp: number;
  files: number;
}

export function readClaudeRewindCheckpoints(
  cwd: string,
  sessionId: string,
  limit: number,
): ClaudeRewindCheckpoint[] {
  const file = path.join(getClaudeProjectDir(cwd), `${sessionId}.jsonl`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const snapshots = new Map<string, number>();
  const checkpoints: ClaudeRewindCheckpoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(value);
    const type = readString(record.type);

    if (type === "file-history-snapshot") {
      const snapshot = asRecord(record.snapshot);
      const messageId = readString(snapshot.messageId);
      if (!messageId) continue;
      const backups = asRecord(snapshot.trackedFileBackups);
      snapshots.set(messageId, Object.keys(backups).length);
      continue;
    }

    if (type !== "user" || record.isSidechain === true || record.isMeta === true) continue;
    const message = asRecord(record.message);
    if (message.role !== "user") continue;
    const messageId = readString(record.uuid);
    if (!messageId) continue;
    const preview = previewClaudeUserContent(message.content);
    if (!preview) continue;
    const timestamp = Date.parse(readString(record.timestamp) ?? "") || Date.now();
    checkpoints.push({
      messageId,
      preview,
      timestamp,
      label: new Date(timestamp).toLocaleString(),
      files: snapshots.get(messageId) ?? 0,
    });
  }

  return checkpoints
    .map((checkpoint) => ({
      ...checkpoint,
      files: snapshots.get(checkpoint.messageId) ?? checkpoint.files,
    }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

export function previewClaudeUserContent(content: unknown): string {
  const raw = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => readString(asRecord(part).text))
          .filter((part): part is string => Boolean(part))
          .join("\n")
      : "";
  if (!raw.trim()) return "";

  const commandName = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (commandName) {
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return truncatePlain(`${commandName}${args ? ` ${args}` : ""}`, 160);
  }

  return truncatePlain(raw.replace(/<[^>]+>/g, " "), 160);
}

export function truncatePlain(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function formatRewindResult(
  result: {
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  },
  dryRun: boolean,
  fallbackFileCount?: number,
): string {
  if (result.error) return `Rewind failed: ${result.error}`;
  if (!result.canRewind) {
    return "Claude Code reported that this checkpoint cannot be rewound.";
  }

  const fileCount = Array.isArray(result.filesChanged)
    ? result.filesChanged.length
    : Math.max(0, Math.floor(fallbackFileCount ?? 0));
  const summary = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  const stats = [
    Number.isFinite(result.insertions) ? `${result.insertions} insertions` : null,
    Number.isFinite(result.deletions) ? `${result.deletions} deletions` : null,
  ].filter(Boolean).join(", ");
  const detail = stats ? ` (${stats})` : "";
  if (dryRun) {
    return `Preview only: rewinding to the selected message would change ${summary}${detail}.`;
  }
  return `Rewound files to the selected message. Changed ${summary}${detail}. Conversation history is unchanged.`;
}

export function getClaudeProjectDir(cwd: string): string {
  const projectId = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, "-");
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  return path.join(claudeConfigDir, "projects", projectId);
}

export function isValidClaudeSession(sessionId: string, cwd: string): boolean {
  if (!isUuid(sessionId)) return false;
  const file = path.join(getClaudeProjectDir(cwd), `${sessionId}.jsonl`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj?.uuid === "string" && obj.uuid.length > 0) return true;
      if (typeof obj?.messageId === "string" && obj.messageId.length > 0) return true;
      if (typeof obj?.leafUuid === "string" && obj.leafUuid.length > 0) return true;
      if (typeof obj?.message?.id === "string" && obj.message.id.length > 0) return true;
      if (
        obj?.sessionId === sessionId &&
        (obj?.type === "user" || obj?.type === "assistant") &&
        obj?.message &&
        typeof obj.message === "object"
      ) {
        return true;
      }
    } catch {}
  }
  return false;
}

export function mergeClaudeSessionTranscript(input: {
  cwd: string;
  sourceSessionId: string;
  targetSessionId: string;
}): void {
  if (
    !isUuid(input.sourceSessionId) ||
    !isUuid(input.targetSessionId) ||
    input.sourceSessionId === input.targetSessionId
  ) {
    return;
  }

  const projectDir = getClaudeProjectDir(input.cwd);
  const sourceFile = path.join(projectDir, `${input.sourceSessionId}.jsonl`);
  const targetFile = path.join(projectDir, `${input.targetSessionId}.jsonl`);
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(sourceFile, "utf8");
  } catch {
    return;
  }

  let targetText = "";
  try {
    targetText = fs.readFileSync(targetFile, "utf8");
  } catch {}

  const targetKeys = new Set<string>();
  for (const line of targetText.split("\n")) {
    const key = transcriptLineKey(line);
    if (key) targetKeys.add(key);
  }

  const linesToAppend: string[] = [];
  let lastTargetUuid = readLastTranscriptUuid(targetText);
  for (const line of sourceText.split("\n")) {
    if (!line.trim()) continue;
    const normalized = normalizeTranscriptLineForSession(
      line,
      input.sourceSessionId,
      input.targetSessionId,
      lastTargetUuid,
    );
    if (!normalized) continue;
    const key = transcriptLineKey(normalized);
    if (key && targetKeys.has(key)) continue;
    if (key) targetKeys.add(key);
    linesToAppend.push(normalized);
    const uuid = readTranscriptUuid(normalized);
    if (uuid) lastTargetUuid = uuid;
  }

  if (linesToAppend.length === 0) return;
  fs.mkdirSync(projectDir, { recursive: true });
  const prefix = targetText && !targetText.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(targetFile, `${prefix}${linesToAppend.join("\n")}\n`);
}

export function normalizeTranscriptLineForSession(
  line: string,
  sourceSessionId: string,
  targetSessionId: string,
  fallbackParentUuid: string | null,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  if (readString(obj.sessionId) !== sourceSessionId) return null;
  obj.sessionId = targetSessionId;
  if (obj.entrypoint === "sdk-ts") {
    obj.entrypoint = "cli";
  }
  if (obj.parentUuid === null && fallbackParentUuid) {
    obj.parentUuid = fallbackParentUuid;
  }
  return JSON.stringify(obj);
}

export function normalizeClaudeSdkTranscriptEntrypoints(input: {
  cwd: string;
  sessionId?: string | null;
}): void {
  if (!input.sessionId || !isUuid(input.sessionId)) return;
  const file = path.join(getClaudeProjectDir(input.cwd), `${input.sessionId}.jsonl`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }

  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!line.trim()) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    const obj = asRecord(parsed);
    if (obj.entrypoint !== "sdk-ts") return line;
    obj.entrypoint = "cli";
    changed = true;
    return JSON.stringify(obj);
  });

  if (!changed) return;
  fs.writeFileSync(file, lines.join("\n"));
}

export function transcriptLineKey(line: string): string | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line.trim();
  }
  const obj = asRecord(parsed);
  return (
    readString(obj.uuid) ??
    readString(obj.messageId) ??
    readString(obj.leafUuid) ??
    readString(obj.promptId) ??
    line.trim()
  );
}

export function readTranscriptUuid(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return readString(asRecord(parsed).uuid);
}

export function readLastTranscriptUuid(text: string): string | null {
  let uuid: string | null = null;
  for (const line of text.split("\n")) {
    const next = readTranscriptUuid(line);
    if (next) uuid = next;
  }
  return uuid;
}

export function findLastClaudeSession(cwd: string): string | null {
  const projectDir = getClaudeProjectDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(projectDir);
  } catch {
    return null;
  }
  const candidates = files
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const id = name.slice(0, -".jsonl".length);
      if (!isUuid(id) || !isValidClaudeSession(id, cwd)) return null;
      try {
        return { id, mtime: fs.statSync(path.join(projectDir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { id: string; mtime: number } => Boolean(item))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.id ?? null;
}
