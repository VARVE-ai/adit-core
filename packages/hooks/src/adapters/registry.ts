/**
 * Platform adapter registry.
 *
 * Discovers, registers, and retrieves platform adapters.
 * Provides both env-var-based detection (for hook dispatching) and
 * directory-based detection (for CLI commands like init/plugin install).
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Platform } from "@varveai/adit-core";
import type { PlatformAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { claudeVscodeAdapter } from "./claude-vscode.js";
import {
  copilotAdapter,
  otherAdapter,
} from "./stub.js";
import { opencodeAdapter } from "./opencode.js";
import { cursorAdapter } from "./cursor.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";

/** Registered adapters keyed by platform */
const adapters = new Map<Platform, PlatformAdapter>();

// Register built-in adapters
adapters.set("claude-code", claudeCodeAdapter);
adapters.set("claude-vscode", claudeVscodeAdapter);

// Register OpenCode adapter (fully implemented)
adapters.set("opencode", opencodeAdapter);

// Register stub adapters (detected but not yet fully implemented)
adapters.set("copilot", copilotAdapter);
adapters.set("other", otherAdapter);

// Register fully implemented adapters
adapters.set("cursor", cursorAdapter);
adapters.set("codex", codexAdapter);
adapters.set("gemini", geminiAdapter);

/** Get the adapter for a platform */
export function getAdapter(platform: Platform): PlatformAdapter {
  const adapter = adapters.get(platform);
  if (!adapter) {
    throw new Error(
      `No adapter registered for platform "${platform}". Available: ${listAdapters().map((a) => a.platform).join(", ")}`,
    );
  }
  return adapter;
}

/** List all registered adapters */
export function listAdapters(): PlatformAdapter[] {
  return Array.from(adapters.values());
}

/** Register a new adapter (for extensibility) */
export function registerAdapter(adapter: PlatformAdapter): void {
  adapters.set(adapter.platform, adapter);
}

/**
 * Detect which supported AI CLIs are installed on this machine by looking
 * for each adapter's `cliBinary` on PATH. No process is executed — this is
 * a pure filesystem lookup, so it is fast and safe to call from init/doctor.
 *
 * Platforms without a `cliBinary` (IDE extensions, manual-only Cursor) are
 * never returned; they are bundled or installed explicitly by the caller.
 */
export function detectInstalledPlatforms(opts?: {
  env?: Record<string, string | undefined>;
  fileExists?: (path: string) => boolean;
  osPlatform?: NodeJS.Platform;
}): Platform[] {
  const env = opts?.env ?? process.env;
  const fileExists = opts?.fileExists ?? existsSync;
  const osPlatform = opts?.osPlatform ?? process.platform;

  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const extensions = osPlatform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  const found: Platform[] = [];
  for (const adapter of listAdapters()) {
    const binary = adapter.cliBinary;
    if (!binary || adapter.hookMappings.length === 0) continue;
    const onPath = dirs.some((dir) =>
      extensions.some((ext) => fileExists(join(dir, binary + ext))),
    );
    if (onPath) found.push(adapter.platform);
  }
  return found;
}

/**
 * Detect the current platform from environment clues.
 * Falls back to "other" when no platform is detected.
 */
export function detectPlatform(): Platform {
  // Hook dispatching always uses the explicit --platform argument; this env
  // detection only backs detectPlatforms() for CLI commands run from inside
  // an AI tool session (e.g. the agent itself running `adit plugin install`).
  //
  // Platform-specific vars are checked BEFORE inherited ones: when running
  // Gemini/Cursor inside another tool's terminal, the parent's env vars
  // (e.g. CLAUDECODE) are inherited by the child, so the child tool's own
  // markers must win.

  // Cursor detection (Cursor sets CURSOR_PROJECT_DIR for hook processes)
  if (process.env.CURSOR_PROJECT_DIR) {
    return "cursor";
  }

  // Gemini CLI detection (Gemini sets these for hook processes)
  if (process.env.GEMINI_SESSION_ID || process.env.GEMINI_PROJECT_DIR) {
    return "gemini";
  }

  // Codex sets no environment markers at all — codex is only detectable via
  // the explicit --platform argument or the .codex directory on disk.

  // Claude Code (CLI or VS Code extension) sets CLAUDECODE=1 in child
  // processes; plugins additionally see CLAUDE_PLUGIN_ROOT.
  // The VS Code extension host additionally sets ELECTRON_RUN_AS_NODE and
  // VSCODE_IPC_HOOK — these are NOT inherited by terminal child processes,
  // so running CLI from VS Code's terminal won't trigger false detection.
  if (process.env.CLAUDECODE || process.env.CLAUDE_PLUGIN_ROOT) {
    if (process.env.ELECTRON_RUN_AS_NODE && process.env.VSCODE_IPC_HOOK) {
      return "claude-vscode";
    }
    return "claude-code";
  }

  // GitHub Copilot detection
  if (process.env.GITHUB_COPILOT || process.env.COPILOT_SESSION) {
    return "copilot";
  }

  // OpenCode detection (Go-based AI coding CLI)
  if (process.env.OPENCODE || process.env.OPENCODE_SESSION) {
    return "opencode";
  }

  // No platform env vars detected — return "other" to stay platform-neutral.
  // Callers that need a concrete adapter should check for "other" and handle
  // it explicitly rather than silently assuming a specific platform.
  return "other";
}

/**
 * Detect which platforms are present in a project by checking for their
 * config directories on disk. Falls back to env-based detection if no
 * platform directories are found.
 *
 * This is the preferred detection method for CLI commands (init, plugin
 * install/uninstall) because env vars are only set inside AI tool sessions,
 * whereas config directories persist on disk.
 */
export function detectPlatforms(projectRoot: string): Platform[] {
  const platforms = new Set<Platform>();

  // Check for Claude Code config directory (shared by CLI and VS Code extension)
  if (existsSync(join(projectRoot, ".claude"))) {
    platforms.add("claude-code");
    platforms.add("claude-vscode");
  }

  // Check for OpenCode config directory or config file
  if (
    existsSync(join(projectRoot, ".opencode")) ||
    existsSync(join(projectRoot, "opencode.json")) ||
    existsSync(join(projectRoot, "opencode.jsonc"))
  ) {
    platforms.add("opencode");
  }

  // Cursor is intentionally NOT auto-detected. Cursor IDE reads both
  // `.cursor/hooks.json` AND `.claude/settings*.json` when both exist,
  // causing duplicate hook invocations. Users must install Cursor hooks
  // explicitly via `adit hook install cursor` if they want Cursor tracking.
  // Detection of `.cursor/` directory alone is not enough reason to install.

  // Check for Codex config directory
  if (existsSync(join(projectRoot, ".codex"))) {
    platforms.add("codex");
  }

  // Check for Gemini config directory
  if (existsSync(join(projectRoot, ".gemini"))) {
    platforms.add("gemini");
  }

  // If no platform directories found, fall back to env detection.
  // This handles cases where adit is run from within an AI tool session
  // (e.g. the AI agent running `adit plugin install`).
  if (platforms.size === 0) {
    const envPlatform = detectPlatform();
    if (envPlatform !== "other") {
      platforms.add(envPlatform);
    }
  }

  return Array.from(platforms);
}
