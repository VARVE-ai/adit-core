import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WINDOWS_SHELL_EXTENSIONS = new Set([".bat", ".cmd"]);
const WINDOWS_NATIVE_EXTENSIONS = new Set([".com", ".exe"]);
const WINDOWS_IGNORED_SHIM_EXTENSIONS = new Set([".ps1"]);

export const CLI_PROCESS_EXIT_WAIT_MS = 750;

export function resolveExecutable(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (hasPathSeparator(trimmed)) {
    return fs.existsSync(trimmed) ? trimmed : null;
  }

  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [trimmed], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return null;
  return pickExecutableCandidate(trimmed, splitExecutableCandidates(result.stdout));
}

export function pickExecutableCandidate(
  command: string,
  candidates: string[],
): string | null {
  const usable = candidates.map((candidate) => candidate.trim()).filter(Boolean);
  if (usable.length === 0) return null;
  if (process.platform !== "win32") return usable[0] ?? null;

  const commandExt = path.win32.extname(command).toLowerCase();
  if (commandExt) {
    return usable.find((candidate) =>
      path.win32.extname(candidate).toLowerCase() === commandExt
    ) ?? usable[0] ?? null;
  }

  return usable
    .filter((candidate) => !WINDOWS_IGNORED_SHIM_EXTENSIONS.has(path.win32.extname(candidate).toLowerCase()))
    .sort((left, right) => windowsExecutableScore(left) - windowsExecutableScore(right))[0]
    ?? usable[0]
    ?? null;
}

export function spawnCliProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  const shell = options.shell ?? shouldUseWindowsShell(command);
  const invocation = prepareWindowsShellInvocation(command, args, shell);
  return spawn(invocation.command, invocation.args, {
    ...options,
    shell,
    windowsHide: options.windowsHide ?? true,
  });
}

export function spawnCliSync(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): ReturnType<typeof spawnSync> {
  const shell = options.shell ?? shouldUseWindowsShell(command);
  const invocation = prepareWindowsShellInvocation(command, args, shell);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell,
    windowsHide: options.windowsHide ?? true,
  });
}

/**
 * Kill a Windows process tree by root pid via `taskkill /T`. Returns false
 * when unavailable (non-Windows, bad pid, taskkill missing/failed) so callers
 * can fall back to a plain kill().
 */
export function taskkillTree(pid: number | undefined): boolean {
  if (process.platform !== "win32") return false;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Terminate a spawned CLI, including its descendants on Windows. `.cmd`/`.bat`
 * shims run under a cmd.exe shell, so killing only the direct child leaves the
 * real CLI (e.g. claude.exe) alive and still reading the console — which is
 * what broke `/local` reclaim on Windows. On other platforms this is exactly
 * `child.kill(signal)`.
 */
export function killCliProcessTree(
  child: ChildProcess | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child) return;
  const exited = child.exitCode != null || child.signalCode != null;
  if (!exited && taskkillTree(child.pid)) return;
  try {
    child.kill(signal);
  } catch {}
}

export async function stopCliProcessTreeAndWait(
  child: ChildProcess | null | undefined,
  timeoutMs = CLI_PROCESS_EXIT_WAIT_MS,
): Promise<void> {
  if (!child) return;
  const exited = waitForCliProcessExit(child, timeoutMs);
  killCliProcessTree(child);
  await exited;
}

export function waitForCliProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once("exit", finish);
    child.once("close", finish);
  });
}

// With shell:true Node concatenates args into the cmd.exe command line without
// any quoting (DEP0190), so paths containing spaces split apart. Do the join
// ourselves with quotes. Only `shell: true` (cmd.exe) on Windows is handled;
// custom shell strings pass through untouched.
function prepareWindowsShellInvocation(
  command: string,
  args: string[],
  shell: boolean | string | undefined,
): { command: string; args: string[] } {
  if (shell !== true || process.platform !== "win32" || args.length === 0) {
    return { command, args };
  }
  const joined = [command, ...args]
    .map((token) => {
      if (token === "") return '""';
      return /[ \t]/.test(token) ? `"${token}"` : token;
    })
    .join(" ");
  return { command: joined, args: [] };
}

export function shouldUseWindowsShell(command: string): boolean {
  return process.platform === "win32" &&
    WINDOWS_SHELL_EXTENSIONS.has(path.win32.extname(command).toLowerCase());
}

function splitExecutableCandidates(stdout: string): string[] {
  return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function windowsExecutableScore(candidate: string): number {
  const ext = path.win32.extname(candidate).toLowerCase();
  if (WINDOWS_NATIVE_EXTENSIONS.has(ext)) return 0;
  if (WINDOWS_SHELL_EXTENSIONS.has(ext)) return 1;
  if (!ext) return 2;
  return 3;
}
