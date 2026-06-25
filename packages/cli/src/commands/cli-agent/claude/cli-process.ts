import type {
  SpawnedProcess,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { spawnCliProcess } from "../cli-process.js";

export function spawnClaudeCliProcess(options: ClaudeSpawnOptions): SpawnedProcess {
  return spawnCliProcess(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
  }) as SpawnedProcess;
}
