import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalStore, LocalStateError, loginTaskPrefix, windowsLoginTaskState, type LoginTaskState } from "@varveai/adit-core";

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
  state?(): LoginTaskState;
  migrateLegacy?(): Promise<boolean>;
  install(): Promise<void>;
  remove(): Promise<void>;
}

/** One user-login entry per local data directory, installed by startup initialization or settings. */
export class UserLoginRegistration implements StartupRegistration {
  readonly path: string;
  readonly supported: boolean;
  private readonly launcher: string;
  private readonly legacyPath: string;
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
    this.legacyPath = join(options.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${this.label}.lnk`);
    this.path = platform === "win32"
      ? loginTaskPrefix + this.label
      : platform === "darwin"
        ? join(home, "Library", "LaunchAgents", `${this.label}.plist`)
        : join(options.configHome ?? process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "autostart", `${this.label}.desktop`);
  }
  state(): LoginTaskState {
    return this.path.startsWith(loginTaskPrefix) ? windowsLoginTaskState(this.label)
      : existsSync(this.path) ? "registered" : "missing";
  }
  installed(): boolean { return this.supported && this.state() === "registered"; }
  async migrateLegacy(): Promise<boolean> {
    if (!this.path.startsWith(loginTaskPrefix)) return false;
    const state = this.state();
    if (state === "registered") {
      if (existsSync(this.legacyPath)) unlinkSync(this.legacyPath);
      return true;
    }
    if (!existsSync(this.legacyPath) || state !== "missing") return false;
    // Respect a user/security product disabling the legacy Startup entry.
    const script = `$ErrorActionPreference='Stop'; $p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'; $v=if (Test-Path -LiteralPath $p -ErrorAction Stop) { Get-ItemProperty -LiteralPath $p -ErrorAction Stop } else { $null }; $b=$v.${quotePS(this.label + ".lnk")}; if ($b -and $b[0] -notin @(2,6)) { 'disabled' } else { 'enabled' }`;
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000 });
    if (stdout.trim() !== "enabled") return false;
    await this.install();
    return true;
  }
  async install(): Promise<void> {
    if (!this.supported) throw new LocalStateError("Login startup is not supported on this platform");
    // The original CLI shim path survives npm upgrades (unlike a resolved pnpm store path).
    const entry = this.options.entry ?? process.env.ADIT_CLI_ENTRY ?? fileURLToPath(new URL("../index.js", import.meta.url));
    const node = this.options.node ?? process.execPath;
    if (!existsSync(entry) || !existsSync(node)) throw new LocalStateError("The installed ADIT executable is unavailable");
    // No credentials or caller environment are persisted. Login starts only the daemon.
    writeAtomic(this.launcher, [
      'const { spawnSync } = require("node:child_process");',
      'const { openSync, closeSync, appendFileSync } = require("node:fs");',
      `const logPath = ${JSON.stringify(join(this.directory, "startup", "startup.log"))};`,
      'const log = openSync(logPath, "a");',
      `process.env.ADIT_LOCAL_DATA_DIR = ${JSON.stringify(resolve(this.directory))};`,
      `process.env.ADIT_CLI_ENTRY = ${JSON.stringify(entry)};`,
      ...(process.env.ADIT_DISABLE_AUTO_UPDATE === "1" ? ['process.env.ADIT_DISABLE_AUTO_UPDATE = "1";'] : []),
      `const result = spawnSync(${JSON.stringify(node)}, [${JSON.stringify(entry)}, "daemon", "start", "--on-login"], { env: process.env, windowsHide: true, stdio: ["ignore", log, log] });`,
      'closeSync(log);',
      'if (result.error || result.status !== 0) appendFileSync(logPath, `${new Date().toISOString()} Login startup failed: ${result.error?.code || result.status}\\n`);',
      "process.exitCode = result.error ? 1 : result.status ?? 1;",
      "",
    ].join("\n"));
    if (!this.path.startsWith(loginTaskPrefix)) mkdirSync(dirname(this.path), { recursive: true });
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      // PowerShell is used only to register the OS task, never as its launch action.
      const script = [
        "$ErrorActionPreference='Stop'",
        "$s=New-Object -ComObject Schedule.Service; $s.Connect()",
        "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "$t=$s.NewTask(0); $t.RegistrationInfo.Description='ADIT background service'",
        "$t.Principal.UserId=$sid; $t.Principal.LogonType=3; $t.Principal.RunLevel=0",
        "$t.Settings.Enabled=$true; $t.Settings.Hidden=$true; $t.Settings.DisallowStartIfOnBatteries=$false; $t.Settings.StopIfGoingOnBatteries=$false; $t.Settings.ExecutionTimeLimit='PT2M'",
        "$trigger=$t.Triggers.Create(9); $trigger.UserId=$sid; $trigger.Enabled=$true",
        "$action=$t.Actions.Create(0)",
        `$action.Path=${quotePS(node)}`,
        `$action.Arguments=${quotePS('"' + this.launcher + '"')}`,
        `$action.WorkingDirectory=${quotePS(resolve(this.directory))}`,
        `$null=$s.GetFolder('\\').RegisterTaskDefinition(${quotePS(this.label)},$t,6,$sid,$null,3)`,
      ].join("\n");
      await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 });
      if (windowsLoginTaskState(this.label, true) !== "registered") throw new LocalStateError("Login startup registration failed");
      if (existsSync(this.legacyPath)) unlinkSync(this.legacyPath);
    } else if (platform === "darwin") {
      writeAtomic(this.path, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${this.label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(this.launcher)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`);
    } else {
      writeAtomic(this.path, `[Desktop Entry]\nType=Application\nName=ADIT background service\nExec=${desktopArg(node)} ${desktopArg(this.launcher)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
    }
  }
  async remove(): Promise<void> {
    if (this.path.startsWith(loginTaskPrefix)) {
      const state = windowsLoginTaskState(this.label, true);
      if (state === "unknown") throw new LocalStateError("Unable to query login startup registration");
      if (state !== "missing") {
        const script = `$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $s.GetFolder('\\').DeleteTask(${quotePS(this.label)},0)`;
        await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 });
        if (windowsLoginTaskState(this.label, true) !== "missing") throw new LocalStateError("Unable to remove login startup registration");
      }
      if (existsSync(this.legacyPath)) unlinkSync(this.legacyPath);
    } else if (existsSync(this.path)) unlinkSync(this.path);
    // Keep the inert launcher so an already-dispatched login task cannot race file removal.
  }
}

export type LoginStartupStatus = { enabled: boolean; requestedEnabled: boolean; registrationState: LoginTaskState; supported: boolean; version: number; error?: string };
type SavedStartup = { enabled: boolean; version: number; registration?: string; error?: string };

export class LoginStartup {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: LocalStore, private readonly registration: StartupRegistration = new UserLoginRegistration(store.directory)) {}
  status(): LoginStartupStatus {
    const saved = this.store.get<SavedStartup>("login-startup", { enabled: false, version: 0 });
    const registrationState = this.registration.state?.() ?? (this.registration.installed() ? "registered" : "missing");
    return { enabled: saved.enabled && registrationState === "registered", requestedEnabled: saved.enabled, registrationState, supported: this.registration.supported, version: saved.version, ...(saved.error ? { error: saved.error } : {}) };
  }
  initialize(): Promise<LoginStartupStatus> {
    const task = this.queue.then(async () => {
      // Set the first-run default once. Explicitly disabled or externally removed
      // registrations must not be silently enabled again on each daemon restart.
      const saved = this.store.get<SavedStartup | null>("login-startup", null);
      if (!this.registration.supported) return this.status();
      if (saved) {
        if (saved.enabled && saved.registration !== this.registration.path) {
          try {
            if (await this.registration.migrateLegacy?.())
              this.store.set("login-startup", { ...saved, version: saved.version + 1, registration: this.registration.path, error: undefined });
          } catch (error) {
            this.store.set("login-startup", { ...saved, error: error instanceof Error ? error.message : "Login startup migration failed" });
          }
        }
        return this.status();
      }
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
