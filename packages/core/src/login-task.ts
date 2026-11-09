import { execFileSync } from "node:child_process";

export type LoginTaskState = "registered" | "missing" | "disabled" | "unknown";
export const loginTaskPrefix = "windows-task:";
const cache = new Map<string, { at: number; state: LoginTaskState }>();

/** Read actual scheduler state, never interpret access denial as an absent task. */
export function windowsLoginTaskState(name: string, refresh = false): LoginTaskState {
  if (process.platform !== "win32" || !/^ai\.varve\.adit\.[a-f0-9]{12}$/.test(name))
    return "unknown";
  const previous = cache.get(name);
  if (!refresh && previous && Date.now() - previous.at < 5000) return previous.state;
  let state: LoginTaskState = "unknown";
  try {
    const script = `$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $t=@($s.GetFolder('\\').GetTasks(1) | Where-Object { $_.Name -eq '${name}' }); if ($t.Count -eq 0) { 'missing' } elseif ($t[0].Enabled) { 'registered' } else { 'disabled' }`;
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (["registered", "missing", "disabled"].includes(output)) state = output as LoginTaskState;
  } catch {
    /* State unknown; preserve consent and offer a diagnostic repair. */
  }
  cache.set(name, { at: Date.now(), state });
  return state;
}
