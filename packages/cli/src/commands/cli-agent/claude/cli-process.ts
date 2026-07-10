import type {
  SpawnedProcess,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { spawnCliProcess, taskkillTree } from "../cli-process.js";

export function spawnClaudeCliProcess(options: ClaudeSpawnOptions): SpawnedProcess {
  const child = spawnCliProcess(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (process.platform === "win32") {
    // The SDK aborts probes via kill(); behind a .cmd shim that would only
    // terminate cmd.exe and leak the real claude.exe grandchild.
    const fallbackKill = child.kill.bind(child);
    child.kill = (signal?: number | NodeJS.Signals): boolean => {
      const exited = child.exitCode != null || child.signalCode != null;
      if (!exited && taskkillTree(child.pid)) return true;
      return fallbackKill(signal);
    };
  }
  return child as SpawnedProcess;
}
