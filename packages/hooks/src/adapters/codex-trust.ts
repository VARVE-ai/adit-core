/**
 * Read-only view of Codex's hook trust state.
 *
 * Codex only runs project-scoped hooks the user has approved inside Codex
 * (via /hooks). Approvals are recorded as `[hooks.state."<key>"]` tables in
 * $CODEX_HOME/config.toml. ADIT reads that file to report whether its hooks
 * are approved yet; it never writes to it — the user-level Codex config is
 * the user's alone.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";

export interface CodexHookState {
  key: string;
  trustedHash: string;
}

interface CodexHookDefinition {
  eventName: string;
  keyLabel: string;
  matcher?: string;
}

const CODEX_HOOK_DEFINITIONS: CodexHookDefinition[] = [
  { eventName: "PreToolUse", keyLabel: "pre_tool_use" },
  { eventName: "PostToolUse", keyLabel: "post_tool_use" },
  { eventName: "UserPromptSubmit", keyLabel: "user_prompt_submit" },
  { eventName: "Stop", keyLabel: "stop" },
  { eventName: "Interrupt", keyLabel: "interrupt" },
];

export function resolveCodexHookTrustConfigPath(codexHome?: string): string {
  return join(codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

/**
 * Compute the trust keys and hashes Codex would record for the matching
 * hook entries, mirroring Codex's own key/hash scheme so the entries can be
 * looked up in config.toml.
 */
export function buildCodexHookStatesForEntries(input: {
  hooksPath: string;
  hooks: Record<string, unknown>;
  matchesEntry: (entry: unknown) => boolean;
}): CodexHookState[] {
  const hooksPath = resolve(input.hooksPath);
  return CODEX_HOOK_DEFINITIONS.flatMap((definition) => {
    const entries = input.hooks[definition.eventName];
    if (!Array.isArray(entries)) return [];

    const states: CodexHookState[] = [];
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = asObject(entries[entryIndex]);
      if (!entry || !input.matchesEntry(entry)) continue;
      const hookEntries = entry.hooks;
      if (!Array.isArray(hookEntries)) continue;
      for (let hookIndex = 0; hookIndex < hookEntries.length; hookIndex++) {
        const hook = asObject(hookEntries[hookIndex]);
        if (!hook || typeof hook.command !== "string") continue;
        states.push({
          key: `${hooksPath}:${definition.keyLabel}:${entryIndex}:${hookIndex}`,
          trustedHash: codexHookTrustedHash({
            eventName: definition.keyLabel,
            matcher: typeof entry.matcher === "string" ? entry.matcher : definition.matcher,
            command: hook.command,
            timeout: typeof hook.timeout === "number" ? hook.timeout : 30,
          }),
        });
      }
    }
    return states;
  });
}

/** Return the states that are not (or no longer) approved in the given config text. */
export function findUntrustedCodexHookStates(
  configText: string | null,
  states: CodexHookState[],
): CodexHookState[] {
  if (!configText) return states;
  const trusted = readTrustedHookStates(configText);
  const entriesByKey = new Map<string, Array<{ enabled?: boolean; trustedHash?: string }>>();
  for (const [key, entry] of trusted) {
    const normalized = normalizeHookStateKey(key);
    const entries = entriesByKey.get(normalized) ?? [];
    entries.push(entry);
    entriesByKey.set(normalized, entries);
  }
  return states.filter((state) => {
    const entries = entriesByKey.get(normalizeHookStateKey(state.key)) ?? [];
    // Windows can retain approvals under both D: and d:. Keep every record
    // so a stale hash cannot hide a matching approval based on file order.
    // Explicit disables remain effective; never infer approval from the path alone.
    return entries.some((entry) => entry.enabled === false) ||
      !entries.some((entry) => entry.trustedHash === state.trustedHash);
  });
}

function normalizeHookStateKey(key: string): string {
  if (process.platform !== "win32") return key;
  const match = key.match(/^(.*)(:[^:]+:\d+:\d+)$/u);
  if (!match) return key;
  // Only the filesystem path is case-insensitive, not the event or indices.
  return `${win32.normalize(match[1]!).toLowerCase()}${match[2]}`;
}

function codexHookTrustedHash(input: {
  eventName: string;
  matcher?: string;
  command: string;
  timeout: number;
}): string {
  const identity: Record<string, unknown> = {
    event_name: input.eventName,
    hooks: [{
      async: false,
      command: input.command,
      timeout: input.timeout,
      type: "command",
    }],
  };
  if (input.matcher) identity.matcher = input.matcher;
  const canonical = JSON.stringify(canonicalJson(identity));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function readTrustedHookStates(text: string): Map<string, { enabled?: boolean; trustedHash?: string }> {
  const states = new Map<string, { enabled?: boolean; trustedHash?: string }>();
  let currentKey: string | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const nextKey = parseCodexTrustTableKey(line, "hooks.state");
    if (nextKey !== null) {
      currentKey = nextKey;
      states.set(currentKey, {});
      continue;
    }
    if (/^\s*\[/u.test(line)) {
      currentKey = null;
      continue;
    }
    if (!currentKey) continue;
    const current = states.get(currentKey);
    if (!current) continue;
    if (/^\s*enabled\s*=\s*true\s*(?:#.*)?$/u.test(line)) {
      current.enabled = true;
      continue;
    }
    if (/^\s*enabled\s*=\s*false\s*(?:#.*)?$/u.test(line)) {
      current.enabled = false;
      continue;
    }
    const hashMatch = line.match(/^\s*trusted_hash\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/u);
    if (hashMatch?.[1]) {
      current.trustedHash = parseTomlString(hashMatch[1]) ?? undefined;
    }
  }
  return states;
}

/** Codex emits literal (single-quoted) TOML keys for Windows paths. */
export function parseCodexTrustTableKey(line: string, table: "hooks.state" | "projects"): string | null {
  const match = line.match(/^\s*\[(hooks\.state|projects)\.("(?:\\.|[^"\\])*"|'[^']*')\]\s*(?:#.*)?$/u);
  if (match?.[1] !== table || !match[2]) return null;
  return parseTomlString(match[2]);
}

function parseTomlString(value: string): string | null {
  if (value.startsWith("'")) return value.slice(1, -1);
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalJson(record[key])]),
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
