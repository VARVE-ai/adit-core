import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface DaemonProcess {
  pid: number;
  processIdentity?: string;
}

export function inspectProcess(pid: number): { identity: string; command: string } | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return null;
    // Windows may deny this probe even for an exited process. Query the OS
    // before deciding whether a lock can be reclaimed.
    if (code !== "EPERM") throw error;
  }
  const options = { encoding: "utf8" as const, windowsHide: true, timeout: 5000 };
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return { identity: `${boot}:${start}`, command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ") };
  }
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ identity = $p.CreationDate.ToUniversalTime().Ticks.ToString(); command = $p.CommandLine } | ConvertTo-Json -Compress }`;
    try {
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], options).trim();
      if (!output) return null;
      const current = JSON.parse(output);
      if (typeof current.identity !== "string" || !current.identity) throw new Error("Missing process birth identity");
      return current;
    } catch {
      throw new Error(`Cannot verify daemon process ${pid}: Windows process query failed. Check access permissions before retrying.`);
    }
  }
  const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { ...options, env: { ...process.env, LC_ALL: "C" } }).trim();
  const match = output.match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
  if (!match) throw new Error(`Cannot inspect daemon process ${pid}`);
  const boot = process.platform === "darwin" ? execFileSync("sysctl", ["-n", "kern.boottime"], options).trim() : "";
  return { identity: `${boot}:${match[1].replace(/\s+/g, " ")}`, command: match[2] };
}

export function ownsDaemonProcess(owner: DaemonProcess): boolean {
  const current = inspectProcess(owner.pid);
  if (!current) return false;
  if (owner.processIdentity) return current.identity === owner.processIdentity;
  if (typeof current.command !== "string" || !current.command.trim())
    throw new Error(`Cannot verify legacy daemon process ${owner.pid}: command line is unavailable`);
  // Compatibility with old locks: a live unrelated process never owns the daemon.
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  const escaped = worker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'])${escaped}(?:[\\s"']|$)`).test(current.command);
}
