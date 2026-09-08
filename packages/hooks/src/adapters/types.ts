/**
 * Platform adapter interface.
 *
 * Each AI CLI tool gets an adapter that translates between
 * the platform's hook/event system and ADIT's internal model.
 */

import type { Platform } from "@varveai/adit-core";

/**
 * Adapter that bridges a specific AI platform's hook system
 * with ADIT's internal event model.
 */
export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: Platform;

  /** Human-readable platform name */
  readonly displayName: string;

  /**
   * Name of the platform's CLI executable on PATH (e.g. "claude").
   * Undefined for platforms that are not standalone CLIs (IDE extensions)
   * or that must be installed manually (Cursor).
   */
  readonly cliBinary?: string;

  /** Hook event mappings: platform event name → ADIT handler */
  readonly hookMappings: HookMapping[];

  /** Parse platform-specific stdin input into ADIT's normalized format */
  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput;

  /** Generate platform-specific hook configuration */
  generateHookConfig(aditBinaryPath: string, projectRoot?: string): PlatformHookConfig;

  /** Validate that the platform is properly configured */
  validateInstallation(projectRoot: string): Promise<ValidationResult>;

  /**
   * Detect whether this platform has any ADIT-managed hook configuration
   * or companion files to remove. This is intentionally looser than
   * validateInstallation() so uninstall can clean partial/broken installs
   * — it may count user-level residue (e.g. Codex trust config).
   */
  hasHooks?(projectRoot: string): Promise<boolean>;

  /**
   * Like hasHooks, but counts project-local evidence only — never
   * user-level residue. The connected-platforms backfill uses this to
   * decide what counts as connected; falls back to hasHooks when absent
   * (correct for adapters whose hasHooks is already project-local).
   */
  hasProjectHooks?(projectRoot: string): Promise<boolean>;

  /**
   * Install/register hooks for this platform into `projectRoot`.
   * `options.hookProjectRoot` bakes a different ADIT project root into the
   * hook command — used when a member repository records into its parent
   * project. Defaults to `projectRoot`.
   */
  installHooks(
    projectRoot: string,
    aditBinaryPath: string,
    options?: { hookProjectRoot?: string },
  ): Promise<void>;

  /** Uninstall/deregister hooks */
  uninstallHooks(projectRoot: string): Promise<void>;
}

/** Maps a platform event to an ADIT handler */
export interface HookMapping {
  /** Platform's event name (e.g., "UserPromptSubmit" for Claude) */
  platformEvent: string;
  /** ADIT's internal handler name */
  aditHandler: AditHookType;
  /** Optional matcher (e.g., "Write|Edit" for PostToolUse) */
  matcher?: string;
}

/** Normalized hook input — platform-agnostic representation */
export interface NormalizedHookInput {
  cwd: string;
  hookType: AditHookType;
  /** CLI identifier for upload routing (e.g., "claude-code", "cursor") */
  platformCli?: Platform;
  /** Session ID from the platform (e.g., Claude Code session_id) */
  platformSessionId?: string;
  /** Path to the session transcript file (JSONL) */
  transcriptPath?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  stopReason?: string;
  /** The assistant's last message text (sent in Stop events) */
  lastAssistantMessage?: string;
  /** Whether the stop hook is active (loop prevention) */
  stopHookActive?: boolean;
  taskId?: string;
  taskSubject?: string;
  taskDescription?: string;
  teammateName?: string;
  teamName?: string;
  notificationMessage?: string;
  notificationTitle?: string;
  notificationType?: string;
  agentId?: string;
  agentType?: string;
  agentTranscriptPath?: string;
  rawPlatformData?: Record<string, unknown>;
}

/** Platform-specific hook configuration output */
export interface PlatformHookConfig {
  /** Platform-specific config file path (relative to project root) */
  configPath: string;
  /** Configuration content to write */
  content: Record<string, unknown>;
}

/** Result of validating a platform installation */
export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * Advisory checks flag problems reinstalling cannot fix (e.g. the user
   * must trust the workspace inside the CLI). They are excluded from
   * `valid` so installers don't loop on them; doctors should surface them
   * as warnings.
   */
  advisory?: boolean;
}

/** All ADIT hook types (task-completed/notification/subagent-* are retired
 * but stay typed so stale installs' hook calls can be parsed and ignored) */
export type AditHookType =
  | "prompt-submit"
  | "stop"
  | "task-completed"
  | "notification"
  | "subagent-start"
  | "subagent-stop";
