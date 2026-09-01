/**
 * Per-project record of which AI platforms the user connected to ADIT.
 *
 * Stored in `.adit/platforms.json`, separate from the project manifest
 * (which only `adit init` may write). This record is the boundary for all
 * automatic hook logic: takeover self-heal and `adit doctor --fix` repair
 * ONLY platforms listed here; a platform the user never connected is never
 * installed automatically, no matter what appears on the machine.
 *
 * Legacy projects (initialized before this record existed) are backfilled
 * on first read: any platform whose config already carries ADIT hooks is
 * treated as connected.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "@varveai/adit-core";
import { listAdapters } from "@varveai/adit-hooks/adapters";

const RECORD_RELATIVE_PATH = join(".adit", "platforms.json");
const RECORD_SCHEMA_VERSION = 1;

export function connectedPlatformsPath(projectRoot: string): string {
  return join(projectRoot, RECORD_RELATIVE_PATH);
}

/**
 * Read the connected-platforms record.
 *
 * Returns null when no (readable) record exists — callers that need the
 * effective list should use ensureConnectedPlatformsRecorded(), which
 * backfills legacy projects instead of treating them as "nothing connected".
 */
export function readConnectedPlatforms(projectRoot: string): Platform[] | null {
  const recordPath = connectedPlatformsPath(projectRoot);
  if (!existsSync(recordPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recordPath, "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const connected = (parsed as Record<string, unknown>).connected;
  if (!Array.isArray(connected)) return null;

  const known = new Set(listAdapters().map((adapter) => adapter.platform as string));
  return connected
    .filter((entry): entry is Platform => typeof entry === "string" && known.has(entry));
}

export function writeConnectedPlatforms(projectRoot: string, platforms: Platform[]): void {
  mkdirSync(join(projectRoot, ".adit"), { recursive: true });
  const unique = Array.from(new Set(platforms)).sort();
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    connected: unique,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(connectedPlatformsPath(projectRoot), JSON.stringify(record, null, 2) + "\n");
}

/**
 * Read the record, backfilling it once for legacy projects: platforms whose
 * config already carries ADIT hooks are recorded as connected.
 */
export async function ensureConnectedPlatformsRecorded(projectRoot: string): Promise<Platform[]> {
  const existing = readConnectedPlatforms(projectRoot);
  if (existing !== null) return existing;

  const derived: Platform[] = [];
  for (const adapter of listAdapters()) {
    if (adapter.hookMappings.length === 0) continue;
    try {
      // Project-local evidence only: hasHooks may count user-level residue
      // (Codex trust config), which must not backfill a fresh project.
      const connected = adapter.hasProjectHooks
        ? await adapter.hasProjectHooks(projectRoot)
        : await adapter.hasHooks?.(projectRoot);
      if (connected) derived.push(adapter.platform);
    } catch {
      // unreadable platform config — leave it out rather than fail the caller
    }
  }
  writeConnectedPlatforms(projectRoot, derived);
  return derived;
}

/** Record additional platforms as connected (used by init and hook install). */
export async function addConnectedPlatforms(
  projectRoot: string,
  platforms: Platform[],
): Promise<Platform[]> {
  const current = await ensureConnectedPlatformsRecorded(projectRoot);
  const merged = Array.from(new Set([...current, ...platforms]));
  writeConnectedPlatforms(projectRoot, merged);
  return merged;
}

/** Remove a platform from the record (used by hook uninstall). */
export async function removeConnectedPlatform(
  projectRoot: string,
  platform: Platform,
): Promise<Platform[]> {
  const current = await ensureConnectedPlatformsRecorded(projectRoot);
  const remaining = current.filter((entry) => entry !== platform);
  writeConnectedPlatforms(projectRoot, remaining);
  return remaining;
}
