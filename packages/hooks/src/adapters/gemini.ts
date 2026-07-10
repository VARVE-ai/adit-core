/**
 * Google Gemini CLI platform adapter.
 *
 * Maps Gemini CLI's hook events to ADIT's internal model.
 * Handles installation into .gemini/settings.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "SessionStart", aditHandler: "session-start" },
  { platformEvent: "BeforeAgent", aditHandler: "prompt-submit" },
  { platformEvent: "AfterAgent", aditHandler: "stop" },
  { platformEvent: "SessionEnd", aditHandler: "session-end" },
  // Shell commands only (matcher is regex-tested against the tool name).
  // File edits are extracted from the transcript at stop; matching all
  // tools would record a notification event for every read-only call.
  // Gemini's shell tool is named run_shell_command (verified against the
  // installed gemini-cli 0.41.2 bundle: TOOL_NAME_MAPPING maps Bash to it).
  { platformEvent: "AfterTool", aditHandler: "notification", matcher: "run_shell_command" },
  { platformEvent: "Notification", aditHandler: "notification" },
];

export const geminiAdapter: PlatformAdapter = {
  platform: "gemini" as Platform,
  displayName: "Gemini CLI",
  hookMappings: HOOK_MAPPINGS,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    const aditHookType = hookType as AditHookType;
    const cwd = (raw.cwd as string) ?? process.cwd();

    return {
      cwd,
      hookType: aditHookType,
      platformCli: "gemini",
      platformSessionId: raw.session_id as string | undefined,
      transcriptPath: raw.transcript_path as string | undefined,
      // Prompt
      prompt: raw.prompt as string | undefined,
      // Tool use
      toolName: raw.tool_name as string | undefined,
      toolInput: raw.tool_input as Record<string, unknown> | undefined,
      toolOutput: raw.tool_response as Record<string, unknown> | undefined,
      // Stop
      stopReason: raw.stop_reason as string | undefined,
      lastAssistantMessage: raw.prompt_response as string | undefined,
      stopHookActive: raw.stop_hook_active as boolean | undefined,
      // Notification
      notificationMessage: raw.message as string | undefined,
      notificationTitle: raw.title as string | undefined,
      notificationType: raw.notification_type as string | undefined,
      // Session lifecycle
      sessionSource: raw.source as string | undefined,
      sessionEndReason: raw.reason as string | undefined,
      // Common metadata
      permissionMode: raw.permission_mode as string | undefined,
      model: raw.model as string | undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string, projectRoot?: string): PlatformHookConfig {
    const makeHook = (hookType: AditHookType) => ({
      type: "command",
      command: buildAditHookCommand(aditBinaryPath, "gemini", hookType, projectRoot),
      // Gemini CLI hook timeouts are in MILLISECONDS (default 60000),
      // unlike Claude Code/Codex/Cursor which use seconds. 10s matches
      // the adit-hook self-kill guard.
      timeout: 10000,
    });
    const makeHookEntry = (hookType: AditHookType) => [{ hooks: [makeHook(hookType)] }];
    const makeMatcherEntry = (matcher: string, hookType: AditHookType) => [
      { matcher, hooks: [makeHook(hookType)] },
    ];

    return {
      configPath: ".gemini/settings.json",
      content: {
        hooks: {
          SessionStart: makeHookEntry("session-start"),
          BeforeAgent: makeHookEntry("prompt-submit"),
          AfterAgent: makeHookEntry("stop"),
          SessionEnd: makeHookEntry("session-end"),
          AfterTool: makeMatcherEntry("run_shell_command", "notification"),
          Notification: makeHookEntry("notification"),
        },
      },
    };
  },

  async validateInstallation(projectRoot: string): Promise<ValidationResult> {
    const checks = [];

    // Check .gemini directory exists
    const geminiDir = join(projectRoot, ".gemini");
    const geminiDirExists = existsSync(geminiDir);
    checks.push({
      name: ".gemini directory",
      ok: geminiDirExists,
      detail: geminiDirExists ? geminiDir : "Not found",
    });

    // Check settings file for hook configuration
    const settingsPath = join(projectRoot, ".gemini", "settings.json");

    let hooksFound = false;
    let hooksDetail = "No hook configuration found";
    const requiredHooks = HOOK_MAPPINGS.map((m) => m.platformEvent);
    const missingHooks: string[] = [];
    const staleHooks: string[] = [];
    const stalePinnedRoots = new Set<string>();

    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (!settings.hooks) {
          hooksDetail = "No hooks section in settings.json";
        } else {
          for (const hookName of requiredHooks) {
            const entries = settings.hooks[hookName];
            if (!Array.isArray(entries)) {
              missingHooks.push(hookName);
              continue;
            }
            const { status, stalePinnedRoots: roots } = classifyAditHookEntries(entries, projectRoot);
            if (status === "absent") missingHooks.push(hookName);
            if (status === "stale") {
              staleHooks.push(hookName);
              roots.forEach((root) => stalePinnedRoots.add(root));
            }
          }

          hooksFound = missingHooks.length === 0 && staleHooks.length === 0;
          hooksDetail = describeHookValidation({
            configPath: settingsPath,
            projectRoot,
            missingHooks,
            staleHooks,
            stalePinnedRoots: Array.from(stalePinnedRoots),
          }).detail;
        }
      } catch {
        hooksDetail = `Failed to parse ${settingsPath}`;
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
    const geminiDir = join(projectRoot, ".gemini");
    if (!existsSync(geminiDir)) {
      mkdirSync(geminiDir, { recursive: true });
    }

    const settingsPath = join(geminiDir, "settings.json");
    let settings: Record<string, unknown> = {};

    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      // An empty file has no user data to protect — treat it as a fresh
      // install. Anything else must parse; refuse to overwrite a file we
      // cannot parse, as it may hold the user's own settings.
      if (raw.trim().length > 0) {
        try {
          settings = JSON.parse(raw);
        } catch {
          throw new Error(
            `${settingsPath} contains invalid JSON. Fix or remove it, then re-run the install.`,
          );
        }
      }
    }

    const hookConfig = this.generateHookConfig(aditBinaryPath, projectRoot);
    const existingHooks = (settings.hooks as Record<string, unknown[]>) ?? {};
    const newHooks = hookConfig.content.hooks as Record<string, unknown[]>;

    // Merge hook entries per event key: preserve other tools' hooks,
    // remove stale ADIT entries, then append new ADIT entries.
    const mergedHooks: Record<string, unknown[]> = { ...existingHooks };
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

    settings.hooks = mergedHooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  },

  async hasHooks(projectRoot: string): Promise<boolean> {
    const settingsPath = join(projectRoot, ".gemini", "settings.json");
    if (!existsSync(settingsPath)) return false;

    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { hooks?: unknown };
      if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
        return false;
      }
      return Object.values(settings.hooks).some((entries) =>
        Array.isArray(entries) && entries.some(entryContainsAditHook),
      );
    } catch {
      return false;
    }
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    const settingsPath = join(projectRoot, ".gemini", "settings.json");
    if (!existsSync(settingsPath)) return;

    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (!settings.hooks) return;

      // Remove ADIT hook entries
      for (const hookName of Object.keys(settings.hooks)) {
        const entries = settings.hooks[hookName];
        if (!Array.isArray(entries)) continue;

        settings.hooks[hookName] = entries.filter(
          (entry: { command?: string; hooks?: Array<{ command?: string }> }) => {
            if (typeof entry.command === "string" && isAditHookCommand(entry.command)) return false;
            if (Array.isArray(entry.hooks)) {
              return !entry.hooks.some((h) => typeof h.command === "string" && isAditHookCommand(h.command));
            }
            return true;
          },
        );

        // Clean up empty arrays
        if (settings.hooks[hookName].length === 0) {
          delete settings.hooks[hookName];
        }
      }

      // Clean up empty hooks object
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
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
