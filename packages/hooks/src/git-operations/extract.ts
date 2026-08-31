import { existsSync, readFileSync } from "node:fs";
import type { Platform } from "@varveai/adit-core";
import {
  codexShellCalls,
  type TranscriptShellCall,
} from "./codex-shell-calls.js";
import { parseGitCommands } from "./command-parser.js";
import type { AgentGitOperation, ExtractGitOperationsInput } from "./types.js";

interface RawEntry {
  type?: string;
  role?: string;
  status?: string;
  id?: string;
  messageID?: string;
  timestamp?: string;
  sessionId?: string;
  sessionID?: string;
  payload?: unknown;
  message?: { content?: unknown };
  content?: unknown;
  toolCalls?: unknown;
  parts?: unknown;
  toolUseResult?: Record<string, unknown> | null;
}

type ShellCall = TranscriptShellCall;

export function extractGitOperations(input: ExtractGitOperationsInput): AgentGitOperation[] {
  if (!input.transcriptPath || !existsSync(input.transcriptPath)) return [];
  const entries = readEntries(input.transcriptPath);
  if (entries.length === 0 || !matchesExpectedSession(entries, input.platform, input.expectedSessionId)) return [];

  const calls = shellCallsForLatestTurn(entries, input.platform);
  const operations: AgentGitOperation[] = [];
  for (const call of calls) {
    const parsed = parseGitCommands(call.command, call.cwd ?? input.defaultCwd);
    parsed.forEach((operation, operationIndex) => {
      operations.push({
        provider: input.platform,
        toolCallId: call.id,
        operationIndex,
        operation: operation.operation,
        status: call.success ? "success" : "error",
        cwd: operation.cwd,
        output: call.output ?? null,
        commitMessage: operation.commitMessage ?? null,
      });
    });
  }
  return operations;
}

function readEntries(path: string): RawEntry[] {
  const entries: RawEntry[] = [];
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) entries.push(parsed as RawEntry);
    } catch {
      // Ignore a partially flushed or malformed transcript line.
    }
  }
  return entries;
}

function matchesExpectedSession(entries: RawEntry[], platform: Platform, expected?: string): boolean {
  if (!expected) return true;
  const observed = sessionId(entries, platform);
  return !observed || observed === expected;
}

function sessionId(entries: RawEntry[], platform: Platform): string | null {
  for (const entry of entries) {
    const direct = stringValue(entry.sessionId) ?? stringValue(entry.sessionID);
    if (direct) return direct;
    if (platform === "codex") {
      const payload = asRecord(entry.payload);
      const candidate = stringValue(payload?.session_id);
      if (candidate) return candidate;
    }
  }
  return null;
}

function shellCallsForLatestTurn(entries: RawEntry[], platform: Platform): ShellCall[] {
  const bounds = latestTurnBounds(entries, platform);
  const turn = entries.slice(bounds.start, bounds.end);
  if (platform === "codex") return codexShellCalls(turn, bounds.start);
  if (platform === "gemini") return geminiShellCalls(turn, bounds.start);
  if (platform === "cursor") return cursorShellCalls(turn, bounds.start);
  if (platform === "opencode") return openCodeShellCalls(turn, bounds.start);
  return claudeShellCalls(turn, bounds.start);
}

function claudeShellCalls(entries: RawEntry[], entryOffset: number): ShellCall[] {
  const results = new Map<string, { success: boolean; output: string | null }>();
  entries.forEach((entry) => {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((block) => {
      const value = asRecord(block);
      if (value?.type !== "tool_result") return;
      const id = stringValue(value.tool_use_id);
      if (!id) return;
      results.set(id, {
        success: value.is_error !== true && entry.toolUseResult?.interrupted !== true,
        output: joinedOutput(entry.toolUseResult) ?? textContent(value.content),
      });
    });
  });

  const calls: ShellCall[] = [];
  entries.forEach((entry, entryIndex) => {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((block, blockIndex) => {
      const value = asRecord(block);
      const name = stringValue(value?.name)?.toLowerCase();
      if (value?.type !== "tool_use" || (name !== "bash" && name !== "shell")) return;
      const id = stringValue(value.id) ?? `claude-shell-${entryOffset + entryIndex}-${blockIndex}`;
      const input = asRecord(value.input);
      const command = stringValue(input?.command) ?? stringValue(input?.cmd);
      if (!command) return;
      const result = results.get(id);
      calls.push({ id, command, success: result?.success ?? false, output: result?.output ?? null });
    });
  });
  return calls;
}

function geminiShellCalls(entries: RawEntry[], entryOffset: number): ShellCall[] {
  const calls: ShellCall[] = [];
  entries.forEach((entry, entryIndex) => {
    if (!Array.isArray(entry.toolCalls)) return;
    entry.toolCalls.forEach((rawCall, callIndex) => {
      const call = asRecord(rawCall);
      if (!call) return;
      const name = stringValue(call?.name)?.toLowerCase();
      if (!name || !["run_shell_command", "shell", "bash", "execute_command"].includes(name)) return;
      const args = asRecord(call.args);
      const command = stringValue(args?.command) ?? stringValue(args?.cmd);
      if (!command) return;
      calls.push({
        id: stringValue(call.id) ?? `gemini-shell-${entryOffset + entryIndex}-${callIndex}`,
        command,
        output: textContent(call.resultDisplay) ?? textContent(call.result),
        success: call.status === "success" || call.status === "completed",
      });
    });
  });
  return calls;
}

function cursorShellCalls(entries: RawEntry[], entryOffset: number): ShellCall[] {
  const success = !entries.some((entry) => entry.type === "turn_ended" && entry.status !== "success");
  const calls: ShellCall[] = [];
  entries.forEach((entry, entryIndex) => {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((rawBlock, blockIndex) => {
      const block = asRecord(rawBlock);
      const name = stringValue(block?.name)?.toLowerCase();
      if (block?.type !== "tool_use" || !name || !["shell", "bash", "terminal"].includes(name)) return;
      const input = asRecord(block.input);
      const command = stringValue(input?.command) ?? stringValue(input?.cmd);
      if (!command) return;
      calls.push({
        id: stringValue(block.id)
          ?? `cursor-shell-${stringValue(entry.messageID) ?? stringValue(entry.id) ?? entryOffset + entryIndex}-${blockIndex}`,
        command,
        success,
        output: null,
      });
    });
  });
  return calls;
}

function openCodeShellCalls(entries: RawEntry[], entryOffset: number): ShellCall[] {
  const calls: ShellCall[] = [];
  entries.forEach((entry, entryIndex) => {
    if (!Array.isArray(entry.parts)) return;
    entry.parts.forEach((rawPart, partIndex) => {
      const part = asRecord(rawPart);
      const name = stringValue(part?.tool)?.toLowerCase();
      if (part?.type !== "tool" || !name || !["bash", "shell"].includes(name)) return;
      const state = asRecord(part.state);
      const input = asRecord(state?.input);
      const command = stringValue(input?.command) ?? stringValue(input?.cmd);
      if (!command) return;
      calls.push({
        id: stringValue(part.callID)
          ?? `opencode-shell-${stringValue(entry.messageID) ?? entryOffset + entryIndex}-${partIndex}`,
        command,
        output: textContent(state?.output),
        success: state?.status === "completed" || state?.status === "success",
      });
    });
  });
  return calls;
}

function latestTurnBounds(entries: RawEntry[], platform: Platform): { start: number; end: number } {
  if (platform === "cursor") {
    let lastEnd = -1;
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]?.type === "turn_ended") {
        lastEnd = index;
        break;
      }
    }
    if (lastEnd >= 0) {
      let previousEnd = -1;
      for (let index = lastEnd - 1; index >= 0; index--) {
        if (entries[index]?.type === "turn_ended") {
          previousEnd = index;
          break;
        }
      }
      return { start: previousEnd + 1, end: lastEnd + 1 };
    }
  }

  for (let index = entries.length - 1; index >= 0; index--) {
    if (isRealUserPrompt(entries[index], platform)) return { start: index, end: entries.length };
  }
  return { start: 0, end: entries.length };
}

function isRealUserPrompt(entry: RawEntry | undefined, platform: Platform): boolean {
  if (!entry) return false;
  if (platform === "codex") {
    const payload = asRecord(entry.payload);
    return payload?.type === "message" && payload.role === "user" && hasText(payload.content);
  }
  if (platform === "gemini") return entry.type === "user" && hasText(entry.content);
  if (platform === "opencode") return entry.role === "user";
  const role = entry.role ?? (entry.type === "user" ? "user" : undefined);
  if (role !== "user") return false;
  const content = entry.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((item) => asRecord(item)?.type !== "tool_result");
}

function hasText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (typeof item === "string") return item.trim().length > 0;
    const record = asRecord(item);
    return typeof record?.text === "string" && record.text.trim().length > 0;
  });
}

function joinedOutput(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  const parts = [value.stdout, value.stderr, value.aggregated_output]
    .filter((item): item is string => typeof item === "string" && item.length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

function textContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.map((item) => {
    if (typeof item === "string") return item;
    return stringValue(asRecord(item)?.text) ?? "";
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!asRecord(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
