import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAditHookCommand } from "./command.js";

function withoutAdit(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const value = entry as Record<string, unknown>;
  if (typeof value.command === "string" && isAditHookCommand(value.command)) return null;
  if (!Array.isArray(value.hooks)) return entry;
  const hooks = value.hooks.filter((hook) => withoutAdit(hook) !== null);
  if (hooks.length === value.hooks.length) return entry;
  return hooks.length ? { ...value, hooks } : null;
}

export function prepareLegacyCursorHooksRemoval(projectRoot: string): {
  hasHooks: boolean;
  remove: () => void;
} {
  const path = join(projectRoot, ".cursor", "hooks.json");
  const unchanged = { hasHooks: false, remove: () => {} };
  if (!existsSync(path)) return unchanged;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid object");
    if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))) {
      throw new Error("Invalid hooks object");
    }
  } catch {
    throw new Error(`${path} contains invalid hook configuration. Fix it before migrating Cursor hooks.`);
  }
  if (!config.hooks) return unchanged;
  const hooks: Record<string, unknown> = {};
  let changed = false;
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) {
      hooks[event] = entries;
      continue;
    }
    const remaining = entries.map(withoutAdit).filter((entry) => entry !== null);
    const eventChanged = JSON.stringify(remaining) !== JSON.stringify(entries);
    changed ||= eventChanged;
    if (remaining.length || !eventChanged) hooks[event] = remaining;
  }
  if (!changed) return unchanged;
  return {
    hasHooks: true,
    remove: () => {
      if (Object.keys(hooks).length) config.hooks = hooks;
      else delete config.hooks;
      writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    },
  };
}
