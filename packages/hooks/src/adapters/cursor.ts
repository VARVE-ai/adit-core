/**
 * Cursor IDE platform adapter.
 *
 * Maps Cursor's hook events to ADIT's internal model.
 * Handles installation into .cursor/hooks.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "@varveai/adit-core";
import type {
  PlatformAdapter,
  HookMapping,
  NormalizedHookInput,
  PlatformHookConfig,
  ValidationResult,
  AditHookType,
} from "./types.js";
import {
  buildAditHookCommand,
  classifyAditHookEntries,
  describeHookValidation,
  isAditHookCommand,
} from "./command.js";
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

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "beforeSubmitPrompt", aditHandler: "prompt-submit" },
  { platformEvent: "stop", aditHandler: "stop" },
  { platformEvent: "sessionStart", aditHandler: "session-start" },
  // afterAgentResponse is deliberately NOT registered: it fires once per
  // assistant message segment and its text duplicates what the stop handler
  // already extracts from the transcript.
];

export const cursorAdapter: PlatformAdapter = {
  platform: "cursor" as Platform,
  displayName: "Cursor",
  hookMappings: HOOK_MAPPINGS,

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
      cwd,
      hookType: aditHookType,
      platformCli: "cursor",
      platformSessionId,
      transcriptPath,
      // Prompt (from beforeSubmitPrompt)
      prompt: raw.prompt as string | undefined,
      // Model (common field)
      model: raw.model as string | undefined,
      // Stop (from stop event — Cursor sends status, not stop_reason;
      // assistant message must be read from transcript JSONL)
      stopReason: raw.status as string | undefined,
      lastAssistantMessage: aditHookType === "stop" && transcriptPath
        ? extractLastAssistantMessage(transcriptPath)
        : undefined,
      // Session start metadata
      sessionSource: raw.composer_mode as string | undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string, projectRoot?: string): PlatformHookConfig {
    // Cursor uses flat format: { command, type, timeout }
    // Timeout is in SECONDS (not milliseconds like Claude Code)
    const makeHookEntry = (hookType: AditHookType) => [
      {
        command: buildAditHookCommand(aditBinaryPath, "cursor", hookType, projectRoot),
        type: "command",
        timeout: 10,
      },
    ];

    return {
      configPath: ".cursor/hooks.json",
      content: {
        // Cursor requires a top-level numeric `version` field. Without it,
        // Cursor rejects the config with "Config version must be a number".
        version: 1,
        hooks: {
          beforeSubmitPrompt: makeHookEntry("prompt-submit"),
          stop: makeHookEntry("stop"),
          sessionStart: makeHookEntry("session-start"),
        },
      },
    };
  },

  async validateInstallation(projectRoot: string): Promise<ValidationResult> {
    const checks = [];

    // Check .cursor directory exists
    const cursorDir = join(projectRoot, ".cursor");
    const cursorDirExists = existsSync(cursorDir);
    checks.push({
      name: ".cursor directory",
      ok: cursorDirExists,
      detail: cursorDirExists ? cursorDir : "Not found",
    });

    // Check hooks file for hook configuration
    const hooksPath = join(projectRoot, ".cursor", "hooks.json");
    let hooksFound = false;
    let hooksDetail = "No hook configuration found";
    const requiredHooks = HOOK_MAPPINGS.map((m) => m.platformEvent);
    const missingHooks: string[] = [];
    const staleHooks: string[] = [];
    const stalePinnedRoots = new Set<string>();
    const brokenHooks: string[] = [];
    const brokenScriptPaths = new Set<string>();

    if (existsSync(hooksPath)) {
      try {
        const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8"));
        if (!hooksConfig.hooks) {
          hooksDetail = "No hooks section found in hooks.json";
        } else {
          for (const hookName of requiredHooks) {
            const entries = hooksConfig.hooks[hookName];
            if (!Array.isArray(entries)) {
              missingHooks.push(hookName);
              continue;
            }
            const { status, stalePinnedRoots: roots, brokenScriptPaths: missingScripts } =
              classifyAditHookEntries(entries, projectRoot);
            if (status === "absent") missingHooks.push(hookName);
            if (status === "stale") {
              staleHooks.push(hookName);
              roots.forEach((root) => stalePinnedRoots.add(root));
            }
            if (status === "broken") {
              brokenHooks.push(hookName);
              missingScripts.forEach((scriptPath) => brokenScriptPaths.add(scriptPath));
            }
          }

          hooksFound = missingHooks.length === 0 && staleHooks.length === 0 &&
            brokenHooks.length === 0;
          hooksDetail = describeHookValidation({
            configPath: hooksPath,
            projectRoot,
            missingHooks,
            staleHooks,
            stalePinnedRoots: Array.from(stalePinnedRoots),
            brokenHooks,
            brokenScriptPaths: Array.from(brokenScriptPaths),
          }).detail;
        }
      } catch {
        hooksDetail = `Failed to parse ${hooksPath}`;
      }
    }

    checks.push({
      name: "Hook configuration",
      ok: hooksFound,
      detail: hooksDetail,
    });

    return {
      valid: checks.every((c) => c.ok),
      checks,
    };
  },

  async installHooks(projectRoot: string, aditBinaryPath: string): Promise<void> {
    const cursorDir = join(projectRoot, ".cursor");
    if (!existsSync(cursorDir)) {
      mkdirSync(cursorDir, { recursive: true });
    }

    const hooksPath = join(cursorDir, "hooks.json");
    let hooksConfig: Record<string, unknown> = {};

    if (existsSync(hooksPath)) {
      const raw = readFileSync(hooksPath, "utf-8");
      // An empty file has no user data to protect — treat it as a fresh
      // install. Anything else must parse; refuse to overwrite a file we
      // cannot parse, as it may hold other tools' hook config.
      if (raw.trim().length > 0) {
        try {
          hooksConfig = JSON.parse(raw);
        } catch {
          throw new Error(
            `${hooksPath} contains invalid JSON. Fix or remove it, then re-run the install.`,
          );
        }
      }
    }

    const hookConfig = this.generateHookConfig(aditBinaryPath, projectRoot);
    const existingHooks = (hooksConfig.hooks as Record<string, unknown[]>) ?? {};
    const newHooks = hookConfig.content.hooks as Record<string, unknown[]>;

    // Merge hook entries per event key: preserve other tools' hooks,
    // remove stale ADIT entries, then append new ADIT entries.
    const mergedHooks = { ...existingHooks } as Record<string, unknown[]>;
    for (const [eventKey, aditEntries] of Object.entries(newHooks)) {
      const existing = Array.isArray(mergedHooks[eventKey]) ? mergedHooks[eventKey] : [];

      // Remove stale ADIT entries (same logic as uninstallHooks)
      const nonAditEntries = existing.filter(
        (raw) => {
          const entry = raw as { command?: string; hooks?: Array<{ command?: string }> };
          if (typeof entry.command === "string" && isAditHookCommand(entry.command)) return false;
          if (Array.isArray(entry.hooks)) {
            return !entry.hooks.some(
              (h) => typeof h.command === "string" && isAditHookCommand(h.command),
            );
          }
          return true;
        },
      );

      // Append new ADIT entries after other tools' hooks
      mergedHooks[eventKey] = [...nonAditEntries, ...aditEntries];
    }

    hooksConfig.hooks = mergedHooks;
    writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n");
    removeAditHookEventFromConfig(hooksPath, "sessionEnd");
  },

  async hasHooks(projectRoot: string): Promise<boolean> {
    const hooksPath = join(projectRoot, ".cursor", "hooks.json");
    if (!existsSync(hooksPath)) return false;

    try {
      const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8")) as { hooks?: unknown };
      if (!hooksConfig.hooks || typeof hooksConfig.hooks !== "object" || Array.isArray(hooksConfig.hooks)) {
        return false;
      }
      return Object.values(hooksConfig.hooks).some((entries) =>
        Array.isArray(entries) && entries.some(entryContainsAditHook),
      );
    } catch {
      return false;
    }
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    const hooksPath = join(projectRoot, ".cursor", "hooks.json");
    if (!existsSync(hooksPath)) return;

    try {
      const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8"));
      if (!hooksConfig.hooks) return;

      // Remove ADIT hook entries
      for (const hookName of Object.keys(hooksConfig.hooks)) {
        const entries = hooksConfig.hooks[hookName];
        if (!Array.isArray(entries)) continue;

        hooksConfig.hooks[hookName] = entries.filter(
          (entry: { command?: string; hooks?: Array<{ command?: string }> }) => {
            if (typeof entry.command === "string" && isAditHookCommand(entry.command)) return false;
            if (Array.isArray(entry.hooks)) {
              return !entry.hooks.some((h) => typeof h.command === "string" && isAditHookCommand(h.command));
            }
            return true;
          },
        );

        // Clean up empty arrays
        if (hooksConfig.hooks[hookName].length === 0) {
          delete hooksConfig.hooks[hookName];
        }
      }

      // Clean up empty hooks object
      if (Object.keys(hooksConfig.hooks).length === 0) {
        delete hooksConfig.hooks;
      }

      writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n");
    } catch {
      // Ignore parse errors
    }
  },
};

function entryContainsAditHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const raw = entry as { command?: string; hooks?: Array<{ command?: string }> };
  if (typeof raw.command === "string" && isAditHookCommand(raw.command)) return true;
  return Array.isArray(raw.hooks) &&
    raw.hooks.some((hook) => typeof hook.command === "string" && isAditHookCommand(hook.command));
}

function removeAditHookEventFromConfig(settingsPath: string, eventName: string): void {
  if (!existsSync(settingsPath)) return;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { hooks?: Record<string, unknown> };
    const entries = settings.hooks?.[eventName];
    if (!Array.isArray(entries)) return;
    const filtered = entries.filter((entry) => !entryContainsAditHook(entry));
    if (filtered.length === 0) delete settings.hooks![eventName];
    else settings.hooks![eventName] = filtered;
    if (Object.keys(settings.hooks!).length === 0) delete settings.hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // Preserve invalid or unreadable user settings.
  }
}
