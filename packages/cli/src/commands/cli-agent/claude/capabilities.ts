import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { CliSlashCommand, CliSlashCommandInfo } from "../types.js";

export type CliPromptMode = "build" | "plan";

export type CliToolScope =
  | "approval"
  | "internal"
  | "internal_plan"
  | "shell"
  | "workspace_read"
  | "workspace_write";

export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

export const EXIT_PLAN_MODE_TOOL = "ExitPlanMode";

export const TODO_WRITE_TOOL = "TodoWrite";

export const CLAUDE_CLOUD_NATIVE_SLASH_COMMANDS = ["rewind"] as const;

export const CLAUDE_CLOUD_WEB_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_CLOUD_RELAY_ADIT_ENV: Readonly<Record<string, string>> = {
  ADIT_CLOUD_AUTO_SYNC: "false",
  ADIT_PROJECT_LINK_AUTO_SYNC: "false",
  ADIT_TRANSCRIPT_UPLOAD: "false",
};

export function hasClaudeWorkspacePath(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return typeof record.file_path === "string" ||
    typeof record.filePath === "string" ||
    typeof record.path === "string";
}

export function claudeToolScope(
  toolName: string,
  mode: CliPromptMode | null,
  input?: unknown,
): CliToolScope {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === EXIT_PLAN_MODE_TOOL.toLowerCase()) return "approval";
  if (
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "multiedit" ||
    normalized === "notebookedit"
  ) {
    return hasClaudeWorkspacePath(input)
      ? "workspace_write"
      : mode === "plan"
        ? "internal_plan"
        : "workspace_write";
  }
  if (
    mode === "plan" &&
    (normalized === "write" ||
      normalized === "edit" ||
      normalized === "multiedit" ||
      normalized === "notebookedit")
  ) {
    return "internal_plan";
  }
  if (normalized === TODO_WRITE_TOOL.toLowerCase()) {
    return mode === "plan" ? "internal_plan" : "internal";
  }
  if (normalized === "bash") return "shell";
  if (
    normalized === "read" ||
    normalized === "grep" ||
    normalized === "glob" ||
    normalized === "ls" ||
    normalized === "webfetch" ||
    normalized === "websearch"
  ) {
    return "workspace_read";
  }
  if (
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "multiedit" ||
    normalized === "notebookedit"
  ) {
    return "workspace_write";
  }
  return "internal";
}

export function buildClaudeCloudRelayEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    TERM: baseEnv.TERM || "xterm-256color",
    COLORTERM: baseEnv.COLORTERM || "truecolor",
    FORCE_COLOR: baseEnv.FORCE_COLOR || "3",
    DISABLE_AUTOUPDATER: "1",
    // Cloud Coding persists live conversation state through the relay websocket.
    // Inherited ADIT hooks should keep their local timeline data until normal sync.
    ...CLAUDE_CLOUD_RELAY_ADIT_ENV,
  };
}

export function commandInfoFromClaudeSlashName(name: string): CliSlashCommandInfo {
  const normalized = name.trim().replace(/^\//, "");
  const description = describeClaudeSlashCommand(normalized.toLowerCase());
  return {
    name: normalized,
    ...(description ? { description } : {}),
  };
}

export function commandInfoFromClaudeSlashCommand(command: SlashCommand): CliSlashCommandInfo {
  const name = command.name.trim().replace(/^\//, "");
  const description = command.description?.trim() || describeClaudeSlashCommand(name.toLowerCase());
  return {
    name,
    ...(description ? { description } : {}),
    argumentHint: command.argumentHint || undefined,
    aliases: command.aliases,
  };
}

export function withClaudeCloudNativeSlashCommands(commands: CliSlashCommandInfo[]): CliSlashCommandInfo[] {
  const merged = new Map<string, CliSlashCommandInfo>();
  for (const command of commands) {
    const name = command.name.trim().replace(/^\//, "");
    if (!name) continue;
    merged.set(name.toLowerCase(), { ...command, name });
  }
  for (const name of CLAUDE_CLOUD_NATIVE_SLASH_COMMANDS) {
    if (!merged.has(name)) {
      merged.set(name, commandInfoFromClaudeSlashName(name));
    }
  }
  return Array.from(merged.values());
}

export function describeClaudeSlashCommand(name: string): string | undefined {
  switch (name) {
    case "compact":
      return "Compact the current Claude Code conversation";
    case "mcp":
      return "Show Claude MCP server status";
    case "skills":
      return "Show Claude skills and slash commands";
    case "rewind":
      return "Rewind Claude Code files when checkpointing is available";
    case "btw":
      return "Send a Claude Code by-the-way note";
    case "memory":
      return "Open Claude Code memory command";
    default:
      return undefined;
  }
}

export function formatClaudeMcpServers(servers: Array<{ name: string; status: string }>): string {
  if (servers.length === 0) {
    return "Claude Code has not reported any MCP servers for this Cloud session.";
  }
  return servers
    .map((server) => `- ${server.name}: ${server.status}`)
    .join("\n");
}

export function formatClaudeSkills(
  skills: string[],
  commands: Map<string, CliSlashCommandInfo>,
): string {
  const parts: string[] = [];
  if (skills.length > 0) {
    parts.push(`Skills:\n${skills.map((skill) => `- ${skill}`).join("\n")}`);
  }
  const commandList = Array.from(commands.values());
  if (commandList.length > 0) {
    parts.push(`Slash commands:\n${commandList.map((command) => `- /${command.name}`).join("\n")}`);
  }
  return parts.join("\n\n") || "Claude Code has not reported any skills or slash commands for this Cloud session.";
}

export function pendingSessionIdFromSlashCommand(command: CliSlashCommand): string | null {
  if (command.sessionId?.startsWith("pending_")) return command.sessionId;
  return null;
}
