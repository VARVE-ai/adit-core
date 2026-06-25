import fs from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import {
  claudeCodeAdapter,
  resolveAditHookBinary,
} from "@varveai/adit-hooks/adapters";

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "Notification",
  "SubagentStop",
  "SessionEnd",
] as const;

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

const STATUSLINE_POST_SCRIPT = [
  "try{",
  "const cp=require('child_process'),http=require('http'),https=require('https');",
  "const e=process.argv[1]?process.argv[1]:'',q=process.argv[2]?process.argv[2]:'',oc=process.argv[3]?Buffer.from(process.argv[3],'base64').toString('utf8'):'';",
  "let d='';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data',c=>{d+=c});",
  "function done(o){if(o)process.stdout.write(o)}",
  "function run(o){",
  "if(!oc)return done(o);",
  "let p;",
  "try{p=cp.spawn(oc,{shell:true,stdio:['pipe','pipe','ignore'],env:process.env})}catch{return done(o)}",
  "let out='';",
  "const t=setTimeout(()=>{try{p.kill()}catch{}},3000);",
  "p.stdout.on('data',c=>{out+=c;if(out.length>200000)out=out.slice(0,200000)});",
  "p.on('close',()=>{clearTimeout(t);done(out?out:(o?o:''))});",
  "try{p.stdin.end(d)}catch{}",
  "}",
  "process.stdin.on('end',()=>{",
  "let x={};",
  "try{x=d?JSON.parse(d):{}}catch{}",
  "const mo=x&&typeof x.model==='object'?x.model:{};",
  "const m=(mo&&typeof mo.display_name==='string'&&mo.display_name.trim())?mo.display_name.trim():((mo&&typeof mo.id==='string'&&mo.id.trim())?mo.id.trim():((typeof x.model==='string'&&x.model.trim())?x.model.trim():''));",
  "if(!e){run(m);return}",
  "if(!m){run(m);return}",
  "let u;",
  "try{u=new URL(e);if(q&&!u.search.includes(q)){const sp=u.search?'&':'?';u=new URL(u.toString()+sp+q)}}catch{run(m);return}",
  "const lib=u.protocol==='https:'?https:http;",
  "const body=JSON.stringify({hook_event_name:'StatusLine',event:'StatusLine',model:m,activeModelId:m,session_id:x.session_id,transcript_path:x.transcript_path,cwd:x.cwd,source:'statusLine'});",
  "let finished=false;",
  "const next=()=>{if(finished)return;finished=true;run(m)};",
  "try{const r=lib.request(u,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},timeout:1000},res=>{res.resume();res.on('end',next)});r.on('timeout',()=>{r.destroy();next()});r.on('error',next);r.end(body)}catch{next()}",
  "setTimeout(next,1500).unref()",
  "});",
  "}catch{process.exit(0)}",
].join("");

const CLAUDE_CLOUD_HOOK_PREFIX = "from=adit-cloud-cli-";

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}

export interface InstalledHooks {
  settingsPath: string;
  cleanup: () => void;
}

export async function ensurePersistentClaudeHooksInstalled(opts: {
  cwd: string;
  aditHookBinary?: string;
}): Promise<boolean> {
  const validation = await claudeCodeAdapter.validateInstallation(opts.cwd);
  if (validation.valid) return false;

  await claudeCodeAdapter.installHooks(
    opts.cwd,
    opts.aditHookBinary ?? resolveAditHookBinary(),
  );
  return true;
}

export async function cleanupStaleClaudeCloudSettings(opts: {
  cwd: string;
  maxAgeMs?: number;
  portProbeTimeoutMs?: number;
  isPortActive?: (port: number) => Promise<boolean>;
}): Promise<string[]> {
  const claudeDir = path.join(opts.cwd, ".claude");
  if (!fs.existsSync(claudeDir)) return [];

  const maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const now = Date.now();
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(claudeDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/^adit-cloud-.+\.settings\.local\.json$/u.test(entry.name)) {
      continue;
    }

    const settingsPath = path.join(claudeDir, entry.name);
    const shouldRemove = await shouldRemoveClaudeCloudSettings({
      settingsPath,
      maxAgeMs,
      now,
      portProbeTimeoutMs: opts.portProbeTimeoutMs,
      isPortActive: opts.isPortActive,
    });
    if (!shouldRemove) continue;

    try {
      fs.unlinkSync(settingsPath);
      removed.push(settingsPath);
    } catch {}
  }

  return removed;
}

export function installClaudeHooks(opts: {
  cwd: string;
  endpoint: string;
  marker: string;
  settingsPath?: string;
}): InstalledHooks {
  const claudeDir = path.join(opts.cwd, ".claude");
  const baseSettingsPath = path.join(claudeDir, "settings.local.json");
  const settingsPath = opts.settingsPath ?? baseSettingsPath;
  const managedSettingsFile = settingsPath !== baseSettingsPath;
  const command = buildCloudHookCommand(opts.endpoint, opts.marker);

  const dirExisted = fs.existsSync(claudeDir);
  const fileExisted = fs.existsSync(settingsPath);
  fs.mkdirSync(claudeDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  const sourceSettingsPath = managedSettingsFile ? baseSettingsPath : settingsPath;
  if (fs.existsSync(sourceSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sourceSettingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }
  const previousStatusLine = existing.statusLine;
  const statusLineCommand = buildCloudStatusLineCommand({
    endpoint: opts.endpoint,
    marker: opts.marker,
    originalCommand: findOriginalStatusLineCommand({
      cwd: opts.cwd,
      existingSettings: existing,
      marker: opts.marker,
    }),
  });

  const hooks = (existing.hooks ??= {}) as Record<string, unknown>;
  for (const eventName of EVENTS) {
    const arr = Array.isArray(hooks[eventName])
      ? hooks[eventName] as Array<Record<string, unknown>>
      : [];
    const filtered = arr.filter((entry) => {
      const inner = entry.hooks;
      return !(
        Array.isArray(inner) &&
        inner.some((hook: HookCommand) =>
          typeof hook?.command === "string" &&
          hook.command.includes(opts.marker)
        )
      );
    });
    filtered.push({ hooks: [{ type: "command", command, timeout: 5000 }] });
    hooks[eventName] = filtered;
  }
  existing.statusLine = {
    type: "command",
    command: statusLineCommand,
    refreshInterval: 1,
  };

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");

  return {
    settingsPath,
    cleanup: () => {
      if (managedSettingsFile) {
        try {
          fs.unlinkSync(settingsPath);
        } catch {}
        return;
      }

      try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        if (parsed?.hooks && typeof parsed.hooks === "object") {
          for (const eventName of Object.keys(parsed.hooks)) {
            if (!Array.isArray(parsed.hooks[eventName])) continue;
            parsed.hooks[eventName] = parsed.hooks[eventName].filter(
              (entry: Record<string, unknown>) => {
                const inner = entry.hooks;
                return !(
                  Array.isArray(inner) &&
                  inner.some((hook: HookCommand) =>
                    typeof hook?.command === "string" &&
                    hook.command.includes(opts.marker)
                  )
                );
              },
            );
            if (parsed.hooks[eventName].length === 0) {
              delete parsed.hooks[eventName];
            }
          }
          if (Object.keys(parsed.hooks).length === 0) delete parsed.hooks;
        }

        const statusLine = asObject(parsed.statusLine);
        const statusLineCommand = statusLine?.command;
        if (
          typeof statusLineCommand === "string" &&
          statusLineCommand.includes(opts.marker)
        ) {
          if (previousStatusLine === undefined) {
            delete parsed.statusLine;
          } else {
            parsed.statusLine = previousStatusLine;
          }
        }

        if (Object.keys(parsed).length === 0 && !fileExisted) {
          try {
            fs.unlinkSync(settingsPath);
          } catch {}
          if (!dirExisted) {
            try {
              fs.rmdirSync(claudeDir);
            } catch {}
          }
          return;
        }

        fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
      } catch {
        // Leave user settings untouched on parse or filesystem failures.
      }
    },
  };
}

async function shouldRemoveClaudeCloudSettings(opts: {
  settingsPath: string;
  maxAgeMs: number;
  now: number;
  portProbeTimeoutMs?: number;
  isPortActive?: (port: number) => Promise<boolean>;
}): Promise<boolean> {
  const port = readClaudeCloudHookPort(opts.settingsPath);
  if (port !== null) {
    try {
      const isActive = opts.isPortActive
        ? await opts.isPortActive(port)
        : await isLocalPortListening(port, opts.portProbeTimeoutMs ?? 150);
      return !isActive;
    } catch {
      return false;
    }
  }

  try {
    const stat = fs.statSync(opts.settingsPath);
    return opts.now - stat.mtimeMs > opts.maxAgeMs;
  } catch {
    return false;
  }
}

function readClaudeCloudHookPort(settingsPath: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }

  const root = asObject(parsed);
  if (!root) return null;
  const hooks = asObject(root.hooks);
  if (!hooks) return null;
  for (const eventHooks of Object.values(hooks)) {
    if (!Array.isArray(eventHooks)) continue;
    for (const entry of eventHooks) {
      const entryObject = asObject(entry);
      if (!entryObject) continue;
      const hookEntries = entryObject.hooks;
      if (!Array.isArray(hookEntries)) continue;
      for (const hook of hookEntries) {
        const hookObject = asObject(hook);
        if (!hookObject) continue;
        const command = hookObject.command;
        if (typeof command !== "string") continue;
        if (!command.includes("from=adit-cloud-cli-")) continue;
        const match = command.match(/https?:\/\/127\.0\.0\.1:(\d+)\/hook\b/u);
        if (!match?.[1]) continue;
        const port = Number.parseInt(match[1], 10);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
      }
    }
  }

  return null;
}

function isLocalPortListening(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (active: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
  });
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

function buildCloudStatusLineCommand(opts: {
  endpoint: string;
  marker: string;
  originalCommand: string | null;
}): string {
  return [
    "node",
    "-e",
    quoteHookCommandArg(STATUSLINE_POST_SCRIPT),
    quoteHookCommandArg(opts.endpoint),
    quoteHookCommandArg(opts.marker),
    quoteHookCommandArg(Buffer.from(opts.originalCommand ?? "", "utf8").toString("base64")),
  ].join(" ");
}

function quoteHookCommandArg(value: string): string {
  if (value.includes("\"")) {
    throw new Error("Hook command arguments cannot contain double quotes");
  }
  return `"${value}"`;
}

function findOriginalStatusLineCommand(opts: {
  cwd: string;
  existingSettings: Record<string, unknown>;
  marker: string;
}): string | null {
  return (
    readStatusLineCommand(opts.existingSettings.statusLine, opts.marker) ??
    readStatusLineCommandFromFile(path.join(opts.cwd, ".claude", "settings.json"), opts.marker) ??
    readStatusLineCommandFromFile(path.join(getClaudeConfigDir(), "settings.json"), opts.marker)
  );
}

function readStatusLineCommandFromFile(filePath: string, marker: string): string | null {
  const parsed = parseObject(readFile(filePath));
  return parsed ? readStatusLineCommand(parsed.statusLine, marker) : null;
}

function readStatusLineCommand(value: unknown, marker: string): string | null {
  const statusLine = asObject(value);
  if (!statusLine) return null;
  const type = typeof statusLine.type === "string" ? statusLine.type : "command";
  const command = typeof statusLine.command === "string" ? statusLine.command.trim() : "";
  if (type !== "command" || !command) return null;
  if (command.includes(marker) || command.includes(CLAUDE_CLOUD_HOOK_PREFIX)) return null;
  return command;
}

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
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
