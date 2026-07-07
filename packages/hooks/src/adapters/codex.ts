/**
 * OpenAI Codex platform adapter.
 *
 * Maps Codex's hook events to ADIT's internal model.
 * Supports all Codex clients: CLI, desktop App, and IDE Extension.
 * All clients share the same hooks.json format and event schema.
 * Handles installation into .codex/hooks.json.
 *
 * Key differences from Claude Code:
 * - SessionStart uses matcher "startup|resume"
 * - PostToolUse uses matcher "Bash"
 * - Hooks must be trusted via [hooks.state] entries in $CODEX_HOME/config.toml
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
  isFixedProjectRootHookCommand,
} from "./command.js";
import {
  ADIT_CODEX_HOOK_TRUST_BLOCK,
  buildCodexHookStatesForEntries,
  codexHookTrustMarkerForPath,
  findUntrustedCodexHookStates,
  removeCodexHookTrustConfig,
  resolveCodexHookTrustConfigPath,
  upsertCodexHookTrustConfig,
} from "./codex-trust.js";

/** Timeout for Codex hooks — in SECONDS (not ms like Claude Code) */
const HOOK_TIMEOUT = 30;

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "SessionStart", aditHandler: "session-start", matcher: "startup|resume" },
  { platformEvent: "UserPromptSubmit", aditHandler: "prompt-submit" },
  { platformEvent: "Stop", aditHandler: "stop" },
  { platformEvent: "PostToolUse", aditHandler: "notification", matcher: "Bash" },
];

export const codexAdapter: PlatformAdapter = {
  platform: "codex" as Platform,
  displayName: "Codex",
  hookMappings: HOOK_MAPPINGS,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    const aditHookType = hookType as AditHookType;
    const cwd = (raw.cwd as string) ?? process.cwd();

    // Field names follow Codex's hook schema (hooks/src/schema.rs):
    // snake_case, session_id on every event, tool_response for results.
    return {
      cwd,
      hookType: aditHookType,
      platformCli: "codex",
      platformSessionId: raw.session_id as string | undefined,
      transcriptPath: raw.transcript_path as string | undefined,
      // Prompt
      prompt: raw.prompt as string | undefined,
      // Stop
      stopReason: raw.stop_reason as string | undefined,
      lastAssistantMessage: raw.last_assistant_message as string | undefined,
      stopHookActive: raw.stop_hook_active as boolean | undefined,
      // Tool use (from PostToolUse)
      toolName: raw.tool_name as string | undefined,
      toolInput: raw.tool_input as Record<string, unknown> | undefined,
      toolOutput: raw.tool_response as Record<string, unknown> | undefined,
      // Session lifecycle
      sessionSource: raw.source as string | undefined,
      sessionEndReason: raw.reason as string | undefined,
      // Common metadata (present in all events)
      permissionMode: raw.permission_mode as string | undefined,
      model: raw.model as string | undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string, projectRoot?: string): PlatformHookConfig {
    const makeHookEntry = (hookType: AditHookType) => [
      {
        hooks: [{
          type: "command",
          command: buildAditHookCommand(aditBinaryPath, "codex", hookType, projectRoot),
          timeout: HOOK_TIMEOUT,
        }],
      },
    ];
    const makeMatcherEntry = (matcher: string, hookType: AditHookType) => [
      {
        matcher,
        hooks: [{
          type: "command",
          command: buildAditHookCommand(aditBinaryPath, "codex", hookType, projectRoot),
          timeout: HOOK_TIMEOUT,
        }],
      },
    ];

    return {
      configPath: ".codex/hooks.json",
      content: {
        hooks: {
          SessionStart: makeMatcherEntry("startup|resume", "session-start"),
          UserPromptSubmit: makeHookEntry("prompt-submit"),
          Stop: makeHookEntry("stop"),
          PostToolUse: makeMatcherEntry("Bash", "notification"),
        },
      },
    };
  },

  async validateInstallation(projectRoot: string): Promise<ValidationResult> {
    const checks = [];

    // Check .codex directory exists
    const codexDir = join(projectRoot, ".codex");
    const codexDirExists = existsSync(codexDir);
    checks.push({
      name: ".codex directory",
      ok: codexDirExists,
      detail: codexDirExists ? codexDir : "Not found",
    });

    // Check hooks file for hook configuration
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    let hooksFound = false;
    let hooksDetail = "No hook configuration found";
    const requiredHooks = HOOK_MAPPINGS.map((m) => m.platformEvent);
    const missingHooks: string[] = [];
    const staleHooks: string[] = [];
    const stalePinnedRoots = new Set<string>();

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
            const { status, stalePinnedRoots: roots } = classifyAditHookEntries(entries, projectRoot);
            if (status === "absent") missingHooks.push(hookName);
            if (status === "stale") {
              staleHooks.push(hookName);
              roots.forEach((root) => stalePinnedRoots.add(root));
            }
          }

          const summary = describeHookValidation({
            configPath: hooksPath,
            projectRoot,
            missingHooks,
            staleHooks,
            stalePinnedRoots: Array.from(stalePinnedRoots),
          });
          hooksFound = summary.ok;
          hooksDetail = summary.detail;
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

    const trustConfigPath = resolveCodexHookTrustConfigPath();
    const trustConfig = readTextFile(trustConfigPath);
    const hookStates = hooksFound
      ? buildCodexHookStatesForEntries({
        hooksPath,
        hooks: readHooksForTrust(hooksPath),
        matchesEntry: (entry) => entryContainsFixedRootAditHook(entry, projectRoot),
      })
      : [];
    const untrustedStates = findUntrustedCodexHookStates(trustConfig, hookStates);
    checks.push({
      name: "Codex hook trust",
      ok: hooksFound && hookStates.length > 0 && untrustedStates.length === 0,
      detail: !hooksFound
        ? "No ADIT Codex hooks found to trust"
        : untrustedStates.length === 0
          ? `All ADIT hooks trusted in ${trustConfigPath}`
          : `${untrustedStates.length} hook(s) need review in Codex. Run 'adit plugin install codex' or open /hooks.`,
    });

    return {
      valid: checks.every((c) => c.ok),
      checks,
    };
  },

  async installHooks(projectRoot: string, aditBinaryPath: string): Promise<void> {
    const codexDir = join(projectRoot, ".codex");
    if (!existsSync(codexDir)) {
      mkdirSync(codexDir, { recursive: true });
    }

    const hooksPath = join(codexDir, "hooks.json");
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

    hooksConfig.hooks = mergedHooks;
    writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n");

    // The hooks feature is stable and enabled by default on Codex >= 0.124
    // (ADIT's baseline), so no [features] toggle is written here.

    const hookStates = buildCodexHookStatesForEntries({
      hooksPath,
      hooks: mergedHooks,
      matchesEntry: (entry) => entryContainsAditHook(entry),
    });
    upsertCodexHookTrustConfig({
      blockName: ADIT_CODEX_HOOK_TRUST_BLOCK,
      marker: codexHookTrustMarkerForPath(hooksPath),
      states: hookStates,
    });
  },

  async hasHooks(projectRoot: string): Promise<boolean> {
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    if (configHasAditHooks(hooksPath)) return true;

    const trustConfig = readTextFile(resolveCodexHookTrustConfigPath());
    const marker = codexHookTrustMarkerForPath(hooksPath);
    return trustConfig !== null && trustConfig.includes(`>>> ${ADIT_CODEX_HOOK_TRUST_BLOCK} ${marker}`);
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    const hooksPath = join(projectRoot, ".codex", "hooks.json");

    if (existsSync(hooksPath)) {
      try {
        const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8"));
        if (hooksConfig.hooks && typeof hooksConfig.hooks === "object" && !Array.isArray(hooksConfig.hooks)) {
          // Remove ADIT hook entries
          for (const hookName of Object.keys(hooksConfig.hooks)) {
            const entries = hooksConfig.hooks[hookName];
            if (!Array.isArray(entries)) continue;

            hooksConfig.hooks[hookName] = entries.filter((entry: unknown) => !entryContainsAditHook(entry));

            // Clean up empty arrays
            if (hooksConfig.hooks[hookName].length === 0) {
              delete hooksConfig.hooks[hookName];
            }
          }

          // Clean up empty hooks object
          if (Object.keys(hooksConfig.hooks).length === 0) {
            delete hooksConfig.hooks;
          }
        }

        writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n");
      } catch {
        // Ignore parse errors
      }
    }

    removeCodexHookTrustConfig({
      blockName: ADIT_CODEX_HOOK_TRUST_BLOCK,
      marker: codexHookTrustMarkerForPath(hooksPath),
    });
  },
};

function configHasAditHooks(hooksPath: string): boolean {
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
}

function readHooksForTrust(hooksPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, "utf-8")) as unknown;
    const hooks = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).hooks
      : null;
    return hooks && typeof hooks === "object" && !Array.isArray(hooks)
      ? hooks as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function entryContainsAditHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const raw = entry as { command?: string; hooks?: Array<{ command?: string }> };
  if (typeof raw.command === "string" && isAditHookCommand(raw.command)) return true;
  return Array.isArray(raw.hooks) &&
    raw.hooks.some((hook) => typeof hook.command === "string" && isAditHookCommand(hook.command));
}

function entryContainsFixedRootAditHook(entry: unknown, projectRoot: string): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const raw = entry as { command?: string; hooks?: Array<{ command?: string }> };
  if (
    typeof raw.command === "string" &&
    isFixedProjectRootHookCommand(raw.command, projectRoot)
  ) return true;
  return Array.isArray(raw.hooks) &&
    raw.hooks.some((hook) =>
      typeof hook.command === "string" &&
      isFixedProjectRootHookCommand(hook.command, projectRoot)
    );
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
