/**
 * Cross-shell hook command construction.
 *
 * Hook configs are stored as command strings and may run under different
 * shells. Keep them free of shell-specific environment-prefix syntax so they
 * work in cmd.exe, PowerShell, Git Bash, and Unix shells.
 */

import { existsSync } from "node:fs";
import type { Platform } from "@varveai/adit-core";
import type { AditHookType } from "./types.js";

export type HookPlatformArg = Platform | "claude";

export interface ParsedHookArgs {
  platform: HookPlatformArg | null;
  hookType: string | null;
  projectRoot: string | null;
}

/** Build an ADIT hook command that is portable across common shells. */
export function buildAditHookCommand(
  aditBinaryPath: string,
  platform: HookPlatformArg,
  hookType: AditHookType,
  projectRoot?: string,
): string {
  const projectRootArg = projectRoot
    ? ` --project-root-b64 ${encodeProjectRoot(projectRoot)}`
    : "";
  return `${aditBinaryPath} --platform ${platform}${projectRootArg} ${hookType}`;
}

/** Parse adit-hook CLI args, preserving compatibility with old positional commands. */
export function parseHookArgs(args: readonly string[]): ParsedHookArgs {
  let platform: HookPlatformArg | null = null;
  let hookType: string | null = null;
  let projectRoot: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--platform") {
      const value = args[index + 1];
      if (isHookPlatformArg(value)) {
        platform = value;
      }
      index++;
      continue;
    }
    if (arg === "--project-root-b64") {
      projectRoot = decodeProjectRoot(args[index + 1]);
      index++;
      continue;
    }
    if (arg?.startsWith("--project-root-b64=")) {
      projectRoot = decodeProjectRoot(arg.slice("--project-root-b64=".length));
      continue;
    }
    if (arg?.startsWith("--platform=")) {
      const value = arg.slice("--platform=".length);
      if (isHookPlatformArg(value)) {
        platform = value;
      }
      continue;
    }
    if (!arg?.startsWith("-") && hookType === null) {
      hookType = arg;
    }
  }

  return { platform, hookType, projectRoot };
}

/** Check whether a command string invokes the ADIT hook dispatcher. */
export function isAditHookCommand(command: string): boolean {
  const normalized = command.replace(/\\/gu, "/").toLowerCase();
  return normalized.includes("adit-hook") || normalized.includes("hooks/dist/index.js");
}

/** Check whether a platform hook entry (flat or nested) invokes the ADIT hook dispatcher. */
export function hookEntryContainsAditCommand(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const raw = entry as { command?: unknown; hooks?: unknown };
  if (typeof raw.command === "string" && isAditHookCommand(raw.command)) return true;
  return Array.isArray(raw.hooks) &&
    raw.hooks.some((hook) => {
      const command = (hook as { command?: unknown } | null)?.command;
      return typeof command === "string" && isAditHookCommand(command);
    });
}

/**
 * Remove ADIT entries from every event in a platform hooks map, except the
 * events listed in `keepEvents`. Other tools' entries are preserved, events
 * left empty are dropped, and non-array values are passed through untouched.
 */
export function stripAditHookEntries(
  hooks: Record<string, unknown>,
  opts?: { keepEvents?: readonly string[] },
): Record<string, unknown> {
  const keep = new Set(opts?.keepEvents ?? []);
  const result: Record<string, unknown> = {};
  for (const [eventKey, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries) || keep.has(eventKey)) {
      result[eventKey] = entries;
      continue;
    }
    const nonAditEntries = entries.filter((entry) => !hookEntryContainsAditCommand(entry));
    if (nonAditEntries.length > 0) result[eventKey] = nonAditEntries;
  }
  return result;
}

/**
 * Merge this release's ADIT entries into an existing platform hooks map.
 *
 * ADIT entries are first removed from EVERY event — including events ADIT
 * no longer installs — so nothing lingers after an upgrade (the same rule
 * uninstall applies). Other tools' entries stay where they are. The current
 * ADIT entries are then appended after other tools' entries under their
 * events, so no per-platform list of retired events is needed.
 */
export function mergeAditHookEntries(
  existingHooks: Record<string, unknown>,
  newHooks: Record<string, unknown[]>,
): Record<string, unknown> {
  const merged = stripAditHookEntries(existingHooks);
  for (const [eventKey, aditEntries] of Object.entries(newHooks)) {
    const existing = merged[eventKey];
    merged[eventKey] = [...(Array.isArray(existing) ? existing : []), ...aditEntries];
  }
  return merged;
}

/** Check whether an ADIT hook command has been upgraded with a fixed project root. */
export function isFixedProjectRootHookCommand(command: string, projectRoot: string): boolean {
  const encodedProjectRoot = encodeProjectRoot(projectRoot);
  return isAditHookCommand(command) &&
    (
      command.includes(`--project-root-b64 ${encodedProjectRoot}`) ||
      command.includes(`--project-root-b64=${encodedProjectRoot}`)
    );
}

export function encodeProjectRoot(projectRoot: string): string {
  return Buffer.from(projectRoot, "utf8").toString("base64url");
}

/**
 * Extract the script file path from a `node "<path>"` hook command — the form
 * resolveAditHookBinary() emits for repo and npm installs. PATH-based forms
 * (`adit-hook`, `npx adit-hook`) carry no checkable file path and return null.
 */
export function extractHookScriptPath(command: string): string | null {
  const match = command.match(
    /^\s*node\s+(?:"([^"]+)"|'([^']+)'|(\S+\.(?:cjs|mjs|js)))(?=\s|$)/u,
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** Decode the pinned project root out of a hook command string, if any. */
export function extractPinnedProjectRoot(command: string): string | null {
  const match = command.match(/--project-root-b64[= ]([A-Za-z0-9_-]+)/u);
  return match ? decodeProjectRoot(match[1]) : null;
}

export type HookEntryRootStatus = "ok" | "broken" | "stale" | "absent";

interface HookEntryLike {
  command?: unknown;
  hooks?: unknown;
}

/**
 * Classify a platform hook entry list against the expected project root.
 *
 * - "ok"     — at least one ADIT command pinned to this project root whose
 *              hook script still exists (or is a PATH-based command we
 *              cannot check)
 * - "broken" — commands are pinned to this root, but every one points at a
 *              hook script file that no longer exists (the adit install they
 *              reference was removed or replaced). They fail silently at
 *              runtime and need `adit init`.
 * - "stale"  — ADIT commands exist, but none carries this root (pre-pin
 *              install, or the project directory moved after install).
 *              These commands no-op at runtime and need `adit init`.
 * - "absent" — no ADIT commands at all
 *
 * Also collects the roots stale commands are pinned to (empty string for
 * commands with no pin), so callers can hint at a moved project, and the
 * missing script paths of broken commands.
 */
export function classifyAditHookEntries(
  entries: unknown[],
  projectRoot: string,
  opts?: { scriptExists?: (scriptPath: string) => boolean },
): { status: HookEntryRootStatus; stalePinnedRoots: string[]; brokenScriptPaths: string[] } {
  const scriptExists = opts?.scriptExists ?? existsSync;
  let sawAdit = false;
  const stalePinnedRoots = new Set<string>();
  const brokenScriptPaths = new Set<string>();

  const inspect = (command: unknown): "ok" | null => {
    if (typeof command !== "string" || !isAditHookCommand(command)) return null;
    if (isFixedProjectRootHookCommand(command, projectRoot)) {
      const scriptPath = extractHookScriptPath(command);
      if (scriptPath && !scriptExists(scriptPath)) {
        brokenScriptPaths.add(scriptPath);
        return null;
      }
      return "ok";
    }
    sawAdit = true;
    stalePinnedRoots.add(extractPinnedProjectRoot(command) ?? "");
    return null;
  };

  for (const raw of entries) {
    const entry = raw as HookEntryLike;
    if (inspect(entry.command) === "ok") {
      return { status: "ok", stalePinnedRoots: [], brokenScriptPaths: [] };
    }
    if (Array.isArray(entry.hooks)) {
      for (const nested of entry.hooks) {
        if (inspect((nested as HookEntryLike).command) === "ok") {
          return { status: "ok", stalePinnedRoots: [], brokenScriptPaths: [] };
        }
      }
    }
  }

  const status: HookEntryRootStatus = brokenScriptPaths.size > 0
    ? "broken"
    : sawAdit
      ? "stale"
      : "absent";
  return {
    status,
    stalePinnedRoots: Array.from(stalePinnedRoots),
    brokenScriptPaths: Array.from(brokenScriptPaths),
  };
}

/**
 * Build the "Hook configuration" check detail shared by platform adapters.
 * Distinguishes hooks that are missing entirely, stale ADIT hooks whose
 * pinned project root is absent or points elsewhere, and broken ADIT hooks
 * whose script file no longer exists.
 */
export function describeHookValidation(input: {
  configPath: string;
  projectRoot: string;
  missingHooks: string[];
  staleHooks: string[];
  stalePinnedRoots: string[];
  brokenHooks?: string[];
  brokenScriptPaths?: string[];
}): { ok: boolean; detail: string } {
  const { configPath, projectRoot, missingHooks, staleHooks, stalePinnedRoots } = input;
  const brokenHooks = input.brokenHooks ?? [];
  const brokenScriptPaths = input.brokenScriptPaths ?? [];
  if (missingHooks.length === 0 && staleHooks.length === 0 && brokenHooks.length === 0) {
    return { ok: true, detail: `All hooks registered in ${configPath}` };
  }

  const parts: string[] = [];
  if (brokenHooks.length > 0) {
    const pathHint = brokenScriptPaths.length > 0
      ? ` (script not found: ${brokenScriptPaths.join(", ")})`
      : "";
    parts.push(
      `Broken ADIT hooks: ${brokenHooks.join(", ")}${pathHint} — the adit install they point at was removed; these fail silently at runtime; re-run \`adit init\` to reinstall`,
    );
  }
  if (staleHooks.length > 0) {
    const otherRoots = stalePinnedRoots.filter((root) => root && root !== projectRoot);
    const movedHint = otherRoots.length > 0
      ? ` (pinned to ${otherRoots.join(", ")} — project moved?)`
      : " (no pinned project root)";
    parts.push(
      `Stale ADIT hooks: ${staleHooks.join(", ")}${movedHint} — these no-op at runtime; re-run \`adit init\` to upgrade`,
    );
  }
  if (missingHooks.length > 0) {
    parts.push(`Missing hooks: ${missingHooks.join(", ")}`);
  }
  return { ok: false, detail: parts.join("; ") };
}

function decodeProjectRoot(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function isHookPlatformArg(value: string | undefined): value is HookPlatformArg {
  return value === "claude"
    || value === "claude-code"
    || value === "claude-vscode"
    || value === "cursor"
    || value === "copilot"
    || value === "opencode"
    || value === "codex"
    || value === "gemini"
    || value === "other";
}
