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
