import fs from "node:fs";
import path from "node:path";
import {
  ADIT_CLOUD_CODEX_HOOK_TRUST_BLOCK,
  buildCodexHookStatesForEntries,
  codexAdapter,
  installCodexHookTrustConfig,
  resolveAditHookBinary,
} from "@varveai/adit-hooks/adapters";

const HOOK_POST_SCRIPT = [
  "try{",
  "const a=process.argv[1]===undefined?'':process.argv[1];",
  "const envE=process.env.ADIT_CLOUD_CODEX_HOOK_ENDPOINT===undefined?'':process.env.ADIT_CLOUD_CODEX_HOOK_ENDPOINT;",
  "const e=a!==''?a:envE;",
  "if(!e)process.exit(0);",
  "const argQ=process.argv[2]===undefined?'':process.argv[2];",
  "const envQ=process.env.ADIT_CLOUD_CODEX_HOOK_MARKER===undefined?argQ:process.env.ADIT_CLOUD_CODEX_HOOK_MARKER;",
  "const q=a!==''?argQ:envQ;",
  "let u=new URL(e);",
  "if(q&&!u.search.includes(q)){const s=u.search?'&':'?';u=new URL(u.toString()+s+q)}",
  "const m=u.protocol==='https:'?require('https'):require('http');",
  "let d='';",
  "let done=false;",
  "const finish=()=>{if(done)return;done=true;process.exit(0)};",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data',c=>{d+=c});",
  "process.stdin.on('end',()=>{try{",
  "const r=m.request(u,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(d)},timeout:3000},res=>{res.resume();res.on('end',finish)});",
  "r.on('timeout',()=>{r.destroy();finish()});",
  "r.on('error',finish);",
  "r.end(d)",
  "}catch{finish()}});",
  "setTimeout(finish,3500).unref();",
  "}catch{process.exit(0)}",
].join("");

const CODEX_CLOUD_HOOK_MARKER = "from=adit-cloud-codex-env";
const CODEX_LEGACY_CLOUD_HOOK_PREFIX = "from=adit-cloud-codex-";

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
}): InstalledHooks {
  const codexDir = path.join(opts.cwd, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  const configPath = path.join(codexDir, "config.toml");
  const hookMarker = opts.marker || CODEX_CLOUD_HOOK_MARKER;
  // Codex stores hooks at project scope, so the relay endpoint must come from
  // the spawned Codex process env instead of being baked into hooks.json.
  const command = buildCloudHookCommand("", hookMarker);
  const codexDirExisted = fs.existsSync(codexDir);
  const originalContent = readFile(hooksPath);
  const hooksFileExisted = originalContent !== null;
  const originalConfigContent = readFile(configPath);
  const configFileExisted = originalConfigContent !== null;
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
  const installedConfigContent = enableCodexHooksFeature(readFile(configPath) ?? "");
  fs.writeFileSync(configPath, installedConfigContent);
  const installedConfigMtimeMs = readMtimeMs(configPath);

  return {
    settingsPath: hooksPath,
    cleanup: () => {
      let hasRemainingProjectHooks = true;
      try {
        const current = parseObject(readFile(hooksPath));
        if (!current) {
          hasRemainingProjectHooks = true;
        } else {
          const currentHooks = asObject(current.hooks);
          if (!currentHooks) {
            hasRemainingProjectHooks = false;
          } else {
            let changed = false;
            for (const eventName of Object.keys(currentHooks)) {
              if (!Array.isArray(currentHooks[eventName])) continue;
              const before = currentHooks[eventName] as unknown[];
              const after = before.filter((entry) =>
                !codexEntryHasMarker(entry, hookMarker) &&
                !codexEntryHasLegacyCloudMarker(entry)
              );
              if (after.length !== before.length) changed = true;
              currentHooks[eventName] = after;
              if (after.length === 0) {
                delete currentHooks[eventName];
              }
            }
            if (Object.keys(currentHooks).length === 0) delete current.hooks;
            hasRemainingProjectHooks = hasCodexHookEntries(current.hooks);
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
        }
      } catch {
        // Leave hooks untouched on cleanup failures.
      }
      cleanupTrustConfig();
      cleanupCodexProjectConfig({
        configPath,
        originalContent: originalConfigContent,
        fileExisted: configFileExisted,
        installedContent: installedConfigContent,
        installedMtimeMs: installedConfigMtimeMs,
        hasRemainingProjectHooks,
      });
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
    ...existing.filter((item) =>
      !codexEntryHasMarker(item, marker) &&
      !codexEntryHasLegacyCloudMarker(item)
    ),
    entry,
  ];
}

function buildCloudHookCommand(endpoint: string, marker: string): string {
  return [
    "node",
    "-e",
    quoteHookCommandArg(HOOK_POST_SCRIPT),
    quoteHookCommandArg(endpoint),
    quoteHookCommandArg(marker),
  ].join(" ");
}

function quoteHookCommandArg(value: string): string {
  if (value.includes("\"")) {
    throw new Error("Hook command arguments cannot contain double quotes");
  }
  return `"${value}"`;
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

function codexEntryHasLegacyCloudMarker(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) =>
    hook &&
    typeof hook === "object" &&
    !Array.isArray(hook) &&
    typeof (hook as HookCommand).command === "string" &&
    (hook as HookCommand).command?.includes(CODEX_LEGACY_CLOUD_HOOK_PREFIX) &&
    !(hook as HookCommand).command?.includes(CODEX_CLOUD_HOOK_MARKER)
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

function enableTomlBooleanFeature(text: string, key: string): string {
  const lines = text ? text.replace(/\s+$/u, "").split(/\r?\n/u) : [];
  const featureHeaderIndex = lines.findIndex((line) => /^\s*\[features\]\s*$/u.test(line));
  if (featureHeaderIndex < 0) {
    if (lines.length > 0) lines.push("");
    lines.push("[features]", `${key} = true`);
    return `${lines.join("\n")}\n`;
  }

  let insertIndex = lines.length;
  for (let index = featureHeaderIndex + 1; index < lines.length; index++) {
    if (/^\s*\[[^\]]+\]\s*$/u.test(lines[index] ?? "")) {
      insertIndex = index;
      break;
    }
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u").test(lines[index] ?? "")) {
      lines[index] = `${key} = true`;
      return `${lines.join("\n")}\n`;
    }
  }

  lines.splice(insertIndex, 0, `${key} = true`);
  return `${lines.join("\n")}\n`;
}

function enableCodexHooksFeature(text: string): string {
  const cleaned = text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*codex_hooks\s*=/u.test(line))
    .join("\n")
    .replace(/\s+$/u, "");
  return enableTomlBooleanFeature(cleaned, "hooks");
}

function cleanupCodexProjectConfig(input: {
  configPath: string;
  originalContent: string | null;
  fileExisted: boolean;
  installedContent: string;
  installedMtimeMs: number | null;
  hasRemainingProjectHooks: boolean;
}): void {
  if (input.hasRemainingProjectHooks) return;
  const currentContent = readFile(input.configPath);
  if (currentContent === null) return;
  if (currentContent !== input.installedContent) return;
  if (!sameMtime(input.installedMtimeMs, readMtimeMs(input.configPath))) return;

  try {
    if (input.fileExisted && input.originalContent !== null) {
      fs.writeFileSync(input.configPath, input.originalContent);
      return;
    }
    fs.unlinkSync(input.configPath);
  } catch {
    // Leave project config untouched on cleanup failures.
  }
}

function hasCodexHookEntries(value: unknown): boolean {
  const hooks = asObject(value);
  if (!hooks) return false;
  return Object.values(hooks).some((entries) =>
    Array.isArray(entries) && entries.length > 0
  );
}

function readMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function sameMtime(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && Math.abs(left - right) < 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
