import type { Platform } from "@varveai/adit-core";
import type { HookPlatformArg } from "./command.js";

export function resolveHookPlatform(
  platform: HookPlatformArg | null,
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Platform | null {
  if (platform === null) return null;
  if (platform === "claude" || platform === "claude-code" || platform === "claude-vscode") {
    if (typeof raw.cursor_version === "string" && raw.cursor_version.trim()) {
      return "cursor";
    }
    if (platform === "claude") {
      return env.ELECTRON_RUN_AS_NODE && env.VSCODE_IPC_HOOK ? "claude-vscode" : "claude-code";
    }
  }
  return platform;
}
