/**
 * Cross-shell hook command construction.
 *
 * Hook configs are stored as command strings and may run under different
 * shells. Keep them free of shell-specific environment-prefix syntax so they
 * work in cmd.exe, PowerShell, Git Bash, and Unix shells.
 */

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

/** Decode the pinned project root out of a hook command string, if any. */
export function extractPinnedProjectRoot(command: string): string | null {
  const match = command.match(/--project-root-b64[= ]([A-Za-z0-9_-]+)/u);
  return match ? decodeProjectRoot(match[1]) : null;
}

export type HookEntryRootStatus = "ok" | "stale" | "absent";

interface HookEntryLike {
  command?: unknown;
  hooks?: unknown;
}

/**
 * Classify a platform hook entry list against the expected project root.
 *
 * - "ok"     — at least one ADIT command pinned to this project root
 * - "stale"  — ADIT commands exist, but none carries this root (pre-pin
 *              install, or the project directory moved after install).
 *              These commands no-op at runtime and need `adit init`.
 * - "absent" — no ADIT commands at all
 *
 * Also collects the roots stale commands are pinned to (empty string for
 * commands with no pin), so callers can hint at a moved project.
 */
export function classifyAditHookEntries(
  entries: unknown[],
  projectRoot: string,
): { status: HookEntryRootStatus; stalePinnedRoots: string[] } {
  let sawAdit = false;
  const stalePinnedRoots = new Set<string>();

  const inspect = (command: unknown): boolean => {
    if (typeof command !== "string" || !isAditHookCommand(command)) return false;
    if (isFixedProjectRootHookCommand(command, projectRoot)) return true;
    sawAdit = true;
    stalePinnedRoots.add(extractPinnedProjectRoot(command) ?? "");
    return false;
  };

  for (const raw of entries) {
    const entry = raw as HookEntryLike;
    if (inspect(entry.command)) return { status: "ok", stalePinnedRoots: [] };
    if (Array.isArray(entry.hooks)) {
      for (const nested of entry.hooks) {
        if (inspect((nested as HookEntryLike).command)) {
          return { status: "ok", stalePinnedRoots: [] };
        }
      }
    }
  }

  return {
    status: sawAdit ? "stale" : "absent",
    stalePinnedRoots: Array.from(stalePinnedRoots),
  };
}

/**
 * Build the "Hook configuration" check detail shared by platform adapters.
 * Distinguishes hooks that are missing entirely from stale ADIT hooks whose
 * pinned project root is absent or points elsewhere.
 */
export function describeHookValidation(input: {
  configPath: string;
  projectRoot: string;
  missingHooks: string[];
  staleHooks: string[];
  stalePinnedRoots: string[];
}): { ok: boolean; detail: string } {
  const { configPath, projectRoot, missingHooks, staleHooks, stalePinnedRoots } = input;
  if (missingHooks.length === 0 && staleHooks.length === 0) {
    return { ok: true, detail: `All hooks registered in ${configPath}` };
  }

  const parts: string[] = [];
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
