/**
 * Cursor IDE platform adapter.
 *
 * Maps Cursor's hook events to ADIT's internal model.
 * Shares Claude-compatible hook installation and parses Cursor payloads.
 */

import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import type { Platform } from "@varveai/adit-core";
import type {
  PlatformAdapter,
  NormalizedHookInput,
  PlatformHookConfig,
  AditHookType,
} from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { prepareLegacyCursorHooksRemoval } from "./cursor-legacy.js";
import {
  assistantTextFromTranscriptEntry,
  type TranscriptEntryLike,
} from "../common/transcript-entry.js";

/**
 * Read the tail of a file (last N bytes) and split into lines.
 * Returns lines in original order (oldest first).
 */
function readTailLines(filePath: string, maxLines: number = 512): string[] {
  const CHUNK = 4096;
  const stat = statSync(filePath);
  const fileSize = stat.size;
  if (fileSize === 0) return [];

  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let lineCount = 0;

    // Read backwards from end of file
    let position = fileSize;
    while (position > 0 && lineCount < maxLines) {
      const readSize = Math.min(CHUNK, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, position);
      chunks.unshift(buf);
      bytesRead += readSize;
      lineCount += buf.toString("utf8").split("\n").length - 1;
    }

    const content = Buffer.concat(chunks).toString("utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    // Keep only the last maxLines
    return lines.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

/**
 * Extract the last assistant message text from a Cursor transcript JSONL file.
 *
 * Cursor's stop event does not include the assistant's response text — only
 * `status` and `transcript_path`. The actual response is in the JSONL transcript.
 *
 * Reads the tail of the file for efficiency, then scans backwards for the
 * last `role: "assistant"` entry with text content.
 */
export function extractLastAssistantMessage(transcriptPath: string): string | undefined {
  try {
    if (!existsSync(transcriptPath)) return undefined;

    const findAssistantText = (lines: string[]): string | undefined => {
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as TranscriptEntryLike;
          const text = assistantTextFromTranscriptEntry(entry);
          if (text) return text;
        } catch {
          // Skip malformed lines
        }
      }
      return undefined;
    };

    // Fast path: parse a large tail window first.
    const tailLines = readTailLines(transcriptPath, 512);
    const fromTail = findAssistantText(tailLines);
    if (fromTail) return fromTail;

    // Fallback: if tail window misses due to very noisy tool events,
    // scan the full transcript to guarantee best-effort extraction.
    const fullContent = readFileSync(transcriptPath, "utf-8");
    const fullLines = fullContent.split("\n").filter((l) => l.trim().length > 0);
    return findAssistantText(fullLines);
  } catch {
    return undefined;
  }
}

export const cursorAdapter: PlatformAdapter = {
  platform: "cursor" as Platform,
  displayName: "Cursor",
  hookMappings: claudeCodeAdapter.hookMappings,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    const aditHookType = hookType as AditHookType;

    // Cursor sends workspace_roots as array; fall back to CURSOR_PROJECT_DIR env
    const workspaceRoots = raw.workspace_roots as string[] | undefined;
    const cwd = (workspaceRoots?.[0] as string)
      ?? process.env.CURSOR_PROJECT_DIR
      ?? process.cwd();

    // Cursor sends conversation_id for most events, session_id for session lifecycle
    const platformSessionId = (raw.conversation_id as string)
      ?? (raw.session_id as string)
      ?? undefined;

    // transcript_path or env var CURSOR_TRANSCRIPT_PATH
    const transcriptPath = (raw.transcript_path as string)
      ?? process.env.CURSOR_TRANSCRIPT_PATH
      ?? undefined;

    return {
      cwd: cwd.replace(/^\/(?=[A-Za-z]:[\\/])/u, ""),
      hookType: aditHookType,
      platformCli: "cursor",
      platformSessionId,
      transcriptPath,
      promptId: (raw.prompt_id ?? raw.generation_id) as string | undefined,
      turnId: raw.generation_id as string | undefined,
      toolName: raw.tool_name === "Shell" ? "Bash" : raw.tool_name as string | undefined,
      toolUseId: (raw.tool_use_id ?? raw.tool_call_id) as string | undefined,
      toolInput: raw.tool_input as Record<string, unknown> | undefined,
      toolOutput: (raw.tool_response ?? raw.tool_output) as Record<string, unknown> | undefined,
      // Prompt (from beforeSubmitPrompt)
      prompt: raw.prompt as string | undefined,
      // Stop (from stop event — Cursor sends status, not stop_reason;
      // assistant message must be read from transcript JSONL)
      stopReason: raw.status as string | undefined,
      lastAssistantMessage: aditHookType === "stop" && transcriptPath
        ? extractLastAssistantMessage(transcriptPath)
        : undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string, projectRoot?: string): PlatformHookConfig {
    return claudeCodeAdapter.generateHookConfig(aditBinaryPath, projectRoot);
  },

  async validateInstallation(projectRoot: string) {
    const result = await claudeCodeAdapter.validateInstallation(projectRoot);
    try {
      const legacy = prepareLegacyCursorHooksRemoval(projectRoot);
      result.checks.push({
        name: "Cursor shared hooks",
        ok: !legacy.hasHooks,
        detail: legacy.hasHooks
          ? "Legacy Cursor hooks remain; run adit init to migrate to shared Claude/Cursor hooks."
          : "Cursor uses the shared Claude hook configuration.",
      });
    } catch (error) {
      result.checks.push({ name: "Cursor shared hooks", ok: false, detail: String(error) });
    }
    result.valid = result.checks.filter((check) => !check.advisory).every((check) => check.ok);
    return result;
  },

  async hasHooks(projectRoot: string): Promise<boolean> {
    if (await claudeCodeAdapter.hasHooks?.(projectRoot)) return true;
    try {
      return prepareLegacyCursorHooksRemoval(projectRoot).hasHooks;
    } catch {
      return false;
    }
  },

  async installHooks(
    projectRoot: string,
    aditBinaryPath: string,
    options?: { hookProjectRoot?: string },
  ): Promise<void> {
    await claudeCodeAdapter.installHooks(projectRoot, aditBinaryPath, options);
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    await claudeCodeAdapter.uninstallHooks(projectRoot);
  },
};
