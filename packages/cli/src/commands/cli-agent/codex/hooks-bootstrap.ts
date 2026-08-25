import fs from "node:fs";
import path from "node:path";
import {
  ADIT_CLOUD_CODEX_HOOK_TRUST_BLOCK,
  buildCodexHookStatesForEntries,
  codexAdapter,
  installCodexHookTrustConfig,
  resolveAditHookBinary,
} from "@varveai/adit-hooks/adapters";
import { buildCloudHookCommand } from "../hook-post-script.js";

const CODEX_CLOUD_HOOK_MARKER = "from=adit-cloud-codex-env";

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}

interface CodexHookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface InstalledHooks {
  settingsPath: string;
  cleanup: () => void;
}

export async function ensurePersistentCodexHooksInstalled(opts: {
  cwd: string;
  aditHookBinary?: string;
}): Promise<boolean> {
  const validation = await codexAdapter.validateInstallation(opts.cwd);
  if (validation.valid) return false;

  await codexAdapter.installHooks(
    opts.cwd,
    opts.aditHookBinary ?? resolveAditHookBinary(),
  );
  return true;
}

export function installCodexHooks(opts: {
  cwd: string;
  endpoint: string;
  marker: string;
  codexHome?: string;
  persistent?: boolean;
}): InstalledHooks {
  const codexDir = path.join(opts.cwd, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  const hookMarker = opts.marker || CODEX_CLOUD_HOOK_MARKER;
  // Codex stores hooks at project scope, so the relay endpoint must come from
  // the spawned Codex process env instead of being baked into hooks.json.
  const command = buildCloudHookCommand("", hookMarker);
  const codexDirExisted = fs.existsSync(codexDir);
  const originalContent = readFile(hooksPath);
  const hooksFileExisted = originalContent !== null;
  fs.mkdirSync(codexDir, { recursive: true });

  const existing = parseObject(originalContent) ?? {};
  const hooks = asObject(existing.hooks) ?? {};
  existing.hooks = hooks;

  setCodexHook(hooks, "SessionStart", {
    matcher: "startup|resume",
    hooks: [{ type: "command", command, timeout: 30 }],
  }, hookMarker);
  setCodexHook(hooks, "UserPromptSubmit", {
    hooks: [{ type: "command", command, timeout: 30 }],
  }, hookMarker);
  setCodexHook(hooks, "Stop", {
    hooks: [{ type: "command", command, timeout: 30 }],
  }, hookMarker);
  setCodexHook(hooks, "PostToolUse", {
    hooks: [{ type: "command", command, timeout: 30 }],
  }, hookMarker);

  const hookStates = buildCodexHookStatesForEntries({
    hooksPath,
    hooks,
    matchesEntry: (entry) => codexEntryHasMarker(entry, hookMarker),
  });
  const cleanupTrustConfig = installCodexHookTrustConfig({
    codexHome: opts.codexHome,
    blockName: ADIT_CLOUD_CODEX_HOOK_TRUST_BLOCK,
    marker: hookMarker,
    states: hookStates,
  });

  fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + "\n");

  return {
    settingsPath: hooksPath,
    cleanup: () => {
      if (opts.persistent) return;
      try {
        const current = parseObject(readFile(hooksPath));
        const currentHooks = current ? asObject(current.hooks) : null;
        if (current && currentHooks) {
          let changed = false;
          for (const eventName of Object.keys(currentHooks)) {
            if (!Array.isArray(currentHooks[eventName])) continue;
            const before = currentHooks[eventName] as unknown[];
            const after = before.filter((entry) => !codexEntryHasMarker(entry, hookMarker));
            if (after.length !== before.length) changed = true;
            currentHooks[eventName] = after;
            if (after.length === 0) {
              delete currentHooks[eventName];
            }
          }
          if (Object.keys(currentHooks).length === 0) delete current.hooks;
          if (changed) {
            if (!hooksFileExisted && Object.keys(current).length === 0) {
              try {
                fs.unlinkSync(hooksPath);
              } catch {}
            } else {
              fs.writeFileSync(hooksPath, JSON.stringify(current, null, 2) + "\n");
            }
          }
        }
      } catch {
        // Leave hooks untouched on cleanup failures.
      }
      cleanupTrustConfig();
      if (!codexDirExisted) {
        try {
          fs.rmdirSync(codexDir);
        } catch {}
      }
    },
  };
}

function setCodexHook(
  hooks: Record<string, unknown>,
  eventName: string,
  entry: CodexHookEntry,
  marker: string,
): void {
  const existing = Array.isArray(hooks[eventName]) ? hooks[eventName] as unknown[] : [];
  hooks[eventName] = [
    ...existing.filter((item) => !codexEntryHasMarker(item, marker)),
    entry,
  ];
}

function codexEntryHasMarker(entry: unknown, marker: string): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) =>
    hook &&
    typeof hook === "object" &&
    !Array.isArray(hook) &&
    typeof (hook as HookCommand).command === "string" &&
    (hook as HookCommand).command?.includes(marker)
  );
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
