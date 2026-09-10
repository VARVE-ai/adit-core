import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDENTITY_FIELDS = ["conversation_id", "generation_id", "hook_event_name", "cursor_version"] as const;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATES = 64;
const MAX_PAYLOAD_AGE_MS = 60_000;

interface HookStdinOptions {
  platform?: NodeJS.Platform;
  tempDirectory?: string;
  now?: number;
}

export function parseHookStdin(
  data: string,
  options: HookStdinOptions = {},
): Record<string, unknown> {
  const text = data.replace(/^\uFEFF/u, "");
  const restored = (options.platform ?? process.platform) === "win32"
    ? recoverCursorPayload(text, options)
    : null;
  return JSON.parse(restored ?? text) as Record<string, unknown>;
}

function readIdentity(text: string): Record<string, string> | null {
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    envelope = parsed as Record<string, unknown>;
  } catch {
    envelope = {};
    for (const field of [...IDENTITY_FIELDS, "session_id"]) {
      const pattern = new RegExp(`(?:^|[,{])\\s*"${field}"\\s*:\\s*"([A-Za-z0-9_.:-]{1,128})"`, "gu");
      const matches = [...text.matchAll(pattern)];
      if (matches.length > 1) return null;
      if (matches.length === 1) envelope[field] = matches[0][1];
    }
  }

  const identity: Record<string, string> = {};
  for (const field of IDENTITY_FIELDS) {
    const value = envelope[field];
    if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) return null;
    identity[field] = value;
  }
  if (envelope.session_id !== undefined) {
    if (typeof envelope.session_id !== "string") return null;
    identity.session_id = envelope.session_id;
  }
  return identity;
}

function recoverCursorPayload(text: string, options: HookStdinOptions): string | null {
  const identity = readIdentity(text);
  if (!identity) return null;

  try {
    const directory = options.tempDirectory ?? tmpdir();
    const now = options.now ?? Date.now();
    const candidates = readdirSync(directory, { withFileTypes: true }).filter((entry) => {
      if (!entry.isFile()) return false;
      const match = /^cursor-hook-payload-\d+-(\d+)-[a-f0-9]+\.json$/u.exec(entry.name);
      if (!match) return false;
      const age = now - Number(match[1]);
      return age >= 0 && age <= MAX_PAYLOAD_AGE_MS;
    });
    if (candidates.length > MAX_CANDIDATES) return null;

    let restored: string | null = null;
    let totalBytes = 0;
    for (const candidate of candidates) {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(join(directory, candidate.name), "r");
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PAYLOAD_BYTES) continue;
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_BYTES) return null;
        const buffer = Buffer.alloc(stat.size);
        const count = readSync(descriptor, buffer, 0, buffer.length, 0);
        if (count !== buffer.length) continue;
        const original = buffer.toString("utf8").replace(/^\uFEFF/u, "");
        const parsed: unknown = JSON.parse(original);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const envelope = parsed as Record<string, unknown>;
        if (![...IDENTITY_FIELDS, "session_id"].every((field) => envelope[field] === identity[field])) continue;
        if (restored !== null) return null;
        restored = original;
      } catch {
        continue;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    return restored;
  } catch {
    return null;
  }
}
