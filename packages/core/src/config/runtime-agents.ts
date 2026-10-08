import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface AgentRuntime {
  pid: number;
  version: string;
  updatedAt: number;
}

/** Local-only heartbeat; Cloud receives this information exclusively via sync. */
export function recordAgentRuntime(
  dataDir: string,
  version: string,
): () => void {
  const directory = join(dataDir, "runtime-agents");
  const path = join(directory, `${process.pid}-${randomUUID()}.json`);
  const update = () => {
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        `${path}.tmp`,
        JSON.stringify({ pid: process.pid, version, updatedAt: Date.now() }),
        { mode: 0o600 },
      );
      renameSync(`${path}.tmp`, path);
    } catch {
      /* A diagnostic record must not prevent an agent from running. */
    }
  };
  update();
  const timer = setInterval(update, 30_000);
  timer.unref();
  const cleanup = () => {
    clearInterval(timer);
    process.removeListener("exit", cleanup);
    try {
      unlinkSync(path);
    } catch {
      /* Already removed. */
    }
  };
  process.once("exit", cleanup);
  return cleanup;
}

export function readAgentRuntimeVersions(
  dataDir: string,
  now = Date.now(),
): string[] {
  const directory = join(dataDir, "runtime-agents");
  const versions = new Set<string>();
  try {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const record = JSON.parse(
          readFileSync(join(directory, entry), "utf8"),
        ) as AgentRuntime;
        if (
          !Number.isInteger(record.pid) ||
          record.pid <= 0 ||
          typeof record.version !== "string" ||
          !Number.isFinite(record.updatedAt) ||
          now - record.updatedAt > 90_000 ||
          record.updatedAt > now + 5000
        )
          continue;
        process.kill(record.pid, 0);
        versions.add(record.version);
      } catch {
        /* Unreadable or no longer running. */
      }
    }
  } catch {
    /* Older clients do not have runtime records. */
  }
  return [...versions];
}
