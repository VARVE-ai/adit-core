import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalStore, LocalStateError } from "@varveai/adit-core";

const exec = promisify(execFile);
const quotePS = (value: string) => `'${value.replaceAll("'", "''")}'`;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// Desktop files unescape values once before parsing the quoted Exec arguments.
const desktopArg = (value: string) => ('"' + value.replace(/[\\"`$]/g, "\\$&") + '"')
  .replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("%", "%%");
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

export interface StartupRegistration {
  supported: boolean;
  path: string;
  installed(): boolean;
  install(): Promise<void>;
  remove(): Promise<void>;
}

/** One user-login entry per local data directory, installed by startup initialization or settings. */
export class UserLoginRegistration implements StartupRegistration {
  readonly path: string;
  readonly supported: boolean;
  private readonly launcher: string;
  private readonly label: string;
  constructor(
    private readonly directory: string,
    private readonly options: {
      platform?: NodeJS.Platform;
      home?: string;
      appData?: string;
      configHome?: string;
      entry?: string;
      node?: string;
    } = {},
  ) {
    const platform = options.platform ?? process.platform;
    const home = options.home ?? homedir();
    this.supported = ["win32", "darwin", "linux"].includes(platform);
    this.label = `ai.varve.adit.${createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 12)}`;
    this.launcher = join(directory, "startup", "start.cjs");
    this.path = platform === "win32"
      ? join(options.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${this.label}.lnk`)
      : platform === "darwin"
        ? join(home, "Library", "LaunchAgents", `${this.label}.plist`)
        : join(options.configHome ?? process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "autostart", `${this.label}.desktop`);
  }
  installed(): boolean { return this.supported && existsSync(this.path); }
  async install(): Promise<void> {
    if (!this.supported) throw new LocalStateError("Login startup is not supported on this platform");
    // The original CLI shim path survives npm upgrades (unlike a resolved pnpm store path).
    const entry = this.options.entry ?? process.env.ADIT_CLI_ENTRY ?? fileURLToPath(new URL("../index.js", import.meta.url));
    const node = this.options.node ?? process.execPath;
    if (!existsSync(entry) || !existsSync(node)) throw new LocalStateError("The installed ADIT executable is unavailable");
    // No credentials or caller environment are persisted. Login starts only the daemon.
    writeAtomic(this.launcher, [
      'const { spawnSync } = require("node:child_process");',
      `process.env.ADIT_LOCAL_DATA_DIR = ${JSON.stringify(resolve(this.directory))};`,
      `process.env.ADIT_CLI_ENTRY = ${JSON.stringify(entry)};`,
      `const result = spawnSync(${JSON.stringify(node)}, [${JSON.stringify(entry)}, "daemon", "start", "--on-login"], { env: process.env, windowsHide: true, stdio: "ignore" });`,
      "process.exitCode = result.error ? 1 : result.status ?? 1;",
      "",
    ].join("\n"));
    mkdirSync(dirname(this.path), { recursive: true });
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      // A shortcut runs a hidden PowerShell launcher; the child Node process also has no console.
      const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const launch = `Start-Process -FilePath ${quotePS(node)} -ArgumentList ${quotePS('"' + this.launcher + '"')} -WindowStyle Hidden`;
      const args = `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(launch, "utf16le").toString("base64")}`;
      const temp = this.path.replace(/\.lnk$/, ".tmp.lnk");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut(${quotePS(temp)})`,
        `$shortcut.TargetPath = ${quotePS(ps)}`,
        `$shortcut.Arguments = ${quotePS(args)}`,
        "$shortcut.WindowStyle = 7",
        "$shortcut.Description = 'ADIT background service'",
        "$shortcut.Save()",
      ].join("\n");
      await exec(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
      renameSync(temp, this.path);
    } else if (platform === "darwin") {
      writeAtomic(this.path, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${this.label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(this.launcher)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`);
    } else {
      writeAtomic(this.path, `[Desktop Entry]\nType=Application\nName=ADIT background service\nExec=${desktopArg(node)} ${desktopArg(this.launcher)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
    }
  }
  async remove(): Promise<void> {
    if (existsSync(this.path)) unlinkSync(this.path);
    // Keep the inert launcher so an already-dispatched login task cannot race file removal.
  }
}

export type LoginStartupStatus = { enabled: boolean; supported: boolean; version: number; error?: string };
type SavedStartup = { enabled: boolean; version: number; registration?: string; error?: string };

export class LoginStartup {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: LocalStore, private readonly registration: StartupRegistration = new UserLoginRegistration(store.directory)) {}
  status(): LoginStartupStatus {
    const saved = this.store.get<SavedStartup>("login-startup", { enabled: false, version: 0 });
    return { enabled: saved.enabled && this.registration.installed(), supported: this.registration.supported, version: saved.version, ...(saved.error ? { error: saved.error } : {}) };
  }
  initialize(): Promise<LoginStartupStatus> {
    const task = this.queue.then(async () => {
      // Set the first-run default once. Explicitly disabled or externally removed
      // registrations must not be silently enabled again on each daemon restart.
      if (this.store.get<SavedStartup | null>("login-startup", null) || !this.registration.supported) return this.status();
      try {
        await this.registration.install();
        if (!this.registration.installed()) throw new LocalStateError("Login startup registration failed");
        this.store.set("login-startup", { enabled: true, version: 1, registration: this.registration.path });
      } catch (error) {
        // A failed OS registration must not prevent manual use of the local service.
        this.store.set("login-startup", { enabled: false, version: 1, error: error instanceof Error ? error.message : String(error) });
      }
      return this.status();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  save(input: Record<string, unknown>): Promise<LoginStartupStatus> {
    const task = this.queue.then(async () => {
      const previous = this.status();
      if (typeof input.enabled !== "boolean") throw new LocalStateError("Expected a boolean");
      if (input.version !== previous.version) throw new LocalStateError("Startup settings changed. Reload before saving.", 409);
      if (input.enabled) await this.registration.install();
      else await this.registration.remove();
      if (input.enabled && !this.registration.installed()) throw new LocalStateError("Login startup registration failed");
      this.store.db.transaction(() => {
        this.store.set("login-startup", { enabled: input.enabled, version: previous.version + 1, registration: this.registration.path });
        if (!input.enabled) {
          // Turning this global permission off pauses every directory, not just the open form.
          for (const workspace of this.store.workspaces()) {
            if (workspace.cloud.mode !== "automatic") continue;
            // A missing/unmounted workspace must not prevent disabling startup.
            this.store.db.prepare("UPDATE adit_local_workspaces SET data=? WHERE id=?").run(JSON.stringify({
              ...workspace, version: workspace.version + 1,
              cloud: { ...workspace.cloud, mode: "manual" }, updatedAt: new Date().toISOString(),
            }), workspace.id);
          }
        }
      }).immediate();
      return this.status();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  assertCloudMode(input: Record<string, unknown>): void {
    if ((input.cloud as { mode?: string } | undefined)?.mode === "automatic" && !this.status().enabled)
      throw new LocalStateError('Enable "Start automatically when you sign in" before automatic cloud sync', 409);
  }
}
