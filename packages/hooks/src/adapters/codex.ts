/**
 * OpenAI Codex platform adapter.
 *
 * Maps Codex's hook events to ADIT's internal model.
 * Supports all Codex clients: CLI, desktop App, and IDE Extension.
 * All clients share the same hooks.json format and event schema.
 * Handles installation into .codex/hooks.json.
 *
 * Codex only runs project hooks the user has approved inside Codex (via
 * /hooks); approvals live in $CODEX_HOME/config.toml. ADIT reads that file
 * to report approval status but never writes to it.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
  mergeAditHookEntries,
} from "./command.js";
import {
  buildCodexHookStatesForEntries,
  findUntrustedCodexHookStates,
  resolveCodexHookTrustConfigPath,
} from "./codex-trust.js";

/** Timeout for Codex hooks — in SECONDS (not ms like Claude Code) */
const HOOK_TIMEOUT = 30;

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "UserPromptSubmit", aditHandler: "prompt-submit" },
  { platformEvent: "Stop", aditHandler: "stop" },
  // Working-tree snapshots around shell commands. Codex reports every
  // exec_command call (also the ones issued from `exec` scripts) as a
  // PreToolUse/PostToolUse pair with tool_name "Bash", a tool_use_id and the
  // turn_id, so shell-driven edits that leave no FileChange record are still
  // attributed to the turn.
  { platformEvent: "PreToolUse", aditHandler: "pre-tool-use", matcher: "Bash" },
  { platformEvent: "PostToolUse", aditHandler: "post-tool-use", matcher: "Bash" },
];

export const codexAdapter: PlatformAdapter = {
  platform: "codex" as Platform,
  displayName: "Codex",
  cliBinary: "codex",
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
      turnId: raw.turn_id as string | undefined,
      // Prompt
      prompt: raw.prompt as string | undefined,
      // Stop
      stopReason: raw.stop_reason as string | undefined,
      lastAssistantMessage: raw.last_assistant_message as string | undefined,
      stopHookActive: raw.stop_hook_active as boolean | undefined,
      // Tool use (PreToolUse / PostToolUse)
      toolName: raw.tool_name as string | undefined,
      toolUseId: raw.tool_use_id as string | undefined,
      toolInput: raw.tool_input as Record<string, unknown> | undefined,
      toolOutput: raw.tool_response as Record<string, unknown> | undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string, projectRoot?: string): PlatformHookConfig {
    const makeHookEntry = (hookType: AditHookType, matcher?: string) => [
      {
        ...(matcher ? { matcher } : {}),
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
          UserPromptSubmit: makeHookEntry("prompt-submit"),
          Stop: makeHookEntry("stop"),
          PreToolUse: makeHookEntry("pre-tool-use", "Bash"),
          PostToolUse: makeHookEntry("post-tool-use", "Bash"),
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

          const summary = describeHookValidation({
            configPath: hooksPath,
            projectRoot,
            missingHooks,
            staleHooks,
            stalePinnedRoots: Array.from(stalePinnedRoots),
            brokenHooks,
            brokenScriptPaths: Array.from(brokenScriptPaths),
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
    // Advisory: ADIT never writes the user-level Codex config, so approval
    // can only happen inside Codex — reinstalling cannot fix it and it must
    // not fail `valid`.
    checks.push({
      name: "Codex hook trust",
      ok: hooksFound && hookStates.length > 0 && untrustedStates.length === 0,
      advisory: true,
      detail: !hooksFound
        ? "No ADIT Codex hooks found to approve"
        : untrustedStates.length === 0
          ? `All ADIT hooks approved in ${trustConfigPath}`
          : `${untrustedStates.length} hook(s) not yet approved in Codex — open this project in Codex and run /hooks to approve them (Codex skips unapproved hooks silently)`,
    });

    // Codex only loads project-scoped hooks in trusted workspaces (>= 0.122).
    // Advisory: reinstalling cannot fix this — the user must trust the
    // project inside Codex — so it must not fail `valid` (that would make
    // ensurePersistentCodexHooksInstalled reinstall on every start).
    const workspaceTrusted = isCodexWorkspaceTrusted(trustConfig, projectRoot);
    checks.push({
      name: "Codex workspace trust",
      ok: workspaceTrusted,
      advisory: true,
      detail: workspaceTrusted
        ? `Workspace trusted in ${trustConfigPath}`
        : "Project is not trusted in Codex — project hooks will not load. Open the project in codex and trust it.",
    });

    return {
      valid: checks.filter((c) => !c.advisory).every((c) => c.ok),
      checks,
    };
  },

  async installHooks(
    projectRoot: string,
    aditBinaryPath: string,
    options?: { hookProjectRoot?: string },
  ): Promise<void> {
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

    const hookConfig = this.generateHookConfig(aditBinaryPath, options?.hookProjectRoot ?? projectRoot);
    const existingHooks = (hooksConfig.hooks as Record<string, unknown[]>) ?? {};
    const newHooks = hookConfig.content.hooks as Record<string, unknown[]>;

    // Merge: strip ADIT entries from every event (including events ADIT no
    // longer installs, so upgrades leave nothing behind), keep other tools'
    // entries, then append this release's ADIT entries.
    const mergedHooks = mergeAditHookEntries(existingHooks, newHooks);

    hooksConfig.hooks = mergedHooks;
    writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n");

    // The hooks feature is stable and enabled by default on Codex >= 0.124
    // (ADIT's baseline), so no [features] toggle is written here.
    //
    // The user-level Codex config ($CODEX_HOME/config.toml) is deliberately
    // left alone: the user approves these hooks inside Codex via /hooks.
  },

  async hasHooks(projectRoot: string): Promise<boolean> {
    // Project files only. Older ADIT versions left trust blocks in the
    // user-level Codex config; that residue is not evidence of an install
    // and ADIT no longer touches the file.
    return configHasAditHooks(join(projectRoot, ".codex", "hooks.json"));
  },

  async hasProjectHooks(projectRoot: string): Promise<boolean> {
    return configHasAditHooks(join(projectRoot, ".codex", "hooks.json"));
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
    // Trust blocks written by older ADIT versions into the user-level Codex
    // config are left in place on purpose — ADIT no longer edits that file.
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

/**
 * Check whether the project is a trusted Codex workspace.
 *
 * Codex records `[projects."<abs path>"]` tables with `trust_level =
 * "trusted"` in $CODEX_HOME/config.toml. Line-based parse of the same file
 * the trust states live in.
 */
function isCodexWorkspaceTrusted(configText: string | null, projectRoot: string): boolean {
  if (!configText) return false;
  const wanted = resolve(projectRoot);
  let inWantedProject = false;
  for (const line of configText.split(/\r?\n/u)) {
    const header = line.match(/^\s*\[projects\.("(?:\\.|[^"\\])*")\]\s*$/u);
    if (header?.[1]) {
      try {
        inWantedProject = resolve(JSON.parse(header[1]) as string) === wanted;
      } catch {
        inWantedProject = false;
      }
      continue;
    }
    if (/^\s*\[[^\]]+\]\s*$/u.test(line)) {
      inWantedProject = false;
      continue;
    }
    if (inWantedProject && /^\s*trust_level\s*=\s*"trusted"\s*(?:#.*)?$/u.test(line)) {
      return true;
    }
  }
  return false;
}
