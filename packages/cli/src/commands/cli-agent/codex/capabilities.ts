import type { CliSlashCommand } from "../types.js";
import { asRecord, readNumber, readString } from "./helpers.js";

export interface CodexSlashCommandSpec {
  name: string;
  description: string;
  method: string;
}

export const CODEX_CAPABILITY_DISCOVERY_METHOD = "adit/capabilities/discover";

export const CODEX_THREAD_SETTINGS_UPDATE_METHOD = "thread/settings/update";

export const CODEX_CLOUD_SLASH_COMMAND_SPECS: CodexSlashCommandSpec[] = [
  { name: "compact", description: "Compress the current Codex thread", method: "thread/compact/start" },
  { name: "mcp", description: "Show Codex MCP server status", method: "mcpServerStatus/list" },
  { name: "skills", description: "List Codex skills", method: "skills/list" },
  { name: "fork", description: "Fork the current Codex thread", method: "thread/fork" },
  { name: "model", description: "List available Codex models", method: "model/list" },
  { name: "new", description: "Start a new Codex thread", method: "thread/start" },
  { name: "clear", description: "Start a clean Codex thread", method: "thread/start" },
];

export const CODEX_MCP_SLASH_COMMAND_PREFIX = "mcp.";

export const CODEX_SYSTEM_SKILLS_RETRY_DELAYS_MS = [250, 1_000];

export function extractCodexMcpServers(value: unknown): Array<Record<string, unknown>> {
  const data = Array.isArray(asRecord(value)?.data) ? asRecord(value)?.data as unknown[] : [];
  return data.map((item) => {
    const server = asRecord(item) ?? {};
    const name = readString(server.name) ?? "unnamed";
    const tools = asRecord(server.tools);
    const toolCount = tools ? Object.keys(tools).length : 0;
    const authStatus = readString(server.authStatus) ?? "unknown";
    const resources = Array.isArray(server.resources) ? server.resources : [];
    const resourceTemplates = Array.isArray(server.resourceTemplates) ? server.resourceTemplates : [];
    return {
      name,
      authStatus,
      toolCount,
      resourceCount: resources.length,
      resourceTemplateCount: resourceTemplates.length,
    };
  });
}

export function formatCodexMcpServers(servers: Array<Record<string, unknown>>): string {
  if (servers.length === 0) return "Codex did not report any MCP servers.";
  return servers.map((server) => {
    const name = readString(server.name) ?? "unnamed";
    const authStatus = readString(server.authStatus) ?? "unknown";
    const toolCount = readNumber(server.toolCount) ?? 0;
    return `- ${name}: auth=${authStatus}, tools=${toolCount}`;
  }).join("\n");
}

export function extractCodexSkills(value: unknown): Array<Record<string, unknown>> {
  const data = Array.isArray(asRecord(value)?.data) ? asRecord(value)?.data as unknown[] : [];
  const skillsOut: Array<Record<string, unknown>> = [];
  for (const entry of data) {
    const record = asRecord(entry) ?? {};
    const cwd = readString(record.cwd);
    const skills = Array.isArray(record.skills) ? record.skills : [];
    for (const rawSkill of skills) {
      const skill = asRecord(rawSkill) ?? {};
      const name = readString(skill.name);
      if (!name) continue;
      const skillInterface = asRecord(skill.interface) ?? {};
      skillsOut.push({
        name,
        displayName: readString(skillInterface.displayName),
        description:
          readString(skillInterface.shortDescription) ??
          readString(skill.shortDescription) ??
          readString(skill.description),
        path: readString(skill.path),
        scope: readString(skill.scope),
        cwd,
        enabled: skill.enabled !== false,
        defaultPrompt:
          readString(skillInterface.defaultPrompt) ??
          readString(skill.defaultPrompt),
      });
    }
  }
  return skillsOut;
}

export function formatCodexSkills(skills: Array<Record<string, unknown>>): string {
  const lines = skills.map((skill) => {
    const name = readString(skill.name);
    if (!name) return null;
    const enabled = skill.enabled === false ? "disabled" : "enabled";
    const cwd = readString(skill.cwd);
    const description = readString(skill.description);
    return `- ${name} (${enabled})${cwd ? ` @ ${cwd}` : ""}${description ? `: ${description}` : ""}`;
  }).filter((line): line is string => Boolean(line));
  return lines.join("\n") || "Codex did not report any skills for this workspace.";
}

export function normalizeSlashCommandName(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : null;
}

export function pendingSessionIdFromSlashCommand(command: CliSlashCommand): string | null {
  if (command.sessionId?.startsWith("pending_")) return command.sessionId;
  return null;
}

export function formatCodexSkillPrompt(skill: Record<string, unknown>, args: string): string {
  const name = readString(skill.name) ?? "skill";
  const path = readString(skill.path);
  const prefix = path ? `[$${name}](${path})` : `$${name}`;
  return `${prefix}${args ? ` ${args}` : ""}`;
}

export function extractCodexSupportedMethodsFromError(error: unknown): Set<string> {
  const message = error instanceof Error ? error.message : String(error);
  const marker = "expected one of ";
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) return new Set<string>();
  const expected = message.slice(markerIndex + marker.length);
  return new Set(
    Array.from(expected.matchAll(/`([^`]+)`/g))
      .map((match) => match[1])
      .filter((method): method is string => Boolean(method)),
  );
}

export function formatCodexModels(value: unknown): string {
  const data = Array.isArray(asRecord(value)?.data) ? asRecord(value)?.data as unknown[] : [];
  const lines = data
    .map((item) => {
      const model = asRecord(item) ?? {};
      const id = readString(model.id) ?? readString(model.model);
      if (!id) return null;
      const displayName = readString(model.displayName);
      const suffix = model.isDefault === true ? " [default]" : "";
      return `- ${displayName ?? id} (${id})${suffix}`;
    })
    .filter((line): line is string => Boolean(line));
  return lines.join("\n") || "Codex did not report any available models.";
}
