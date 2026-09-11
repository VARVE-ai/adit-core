import { fileURLToPath } from "node:url";
import type { TranscriptShellCall } from "./types.js";

interface CodexEntry {
  payload?: unknown;
}

/**
 * Codex records every shell command it ran as an `item_completed` event whose
 * item has `type: "CommandExecution"`: the argv, the exact working directory,
 * the exit code and the full output. The record exists for commands issued
 * directly and for commands issued from `exec` scripts, in the 0.151 and
 * 0.153 transcript formats alike, so it is the only source read here — the
 * script text itself is never interpreted.
 */
export function codexShellCalls(
  entries: CodexEntry[],
  entryOffset: number,
): TranscriptShellCall[] {
  const calls: TranscriptShellCall[] = [];

  entries.forEach((entry, entryIndex) => {
    const item = completedItem(entry.payload);
    if (item?.type !== "CommandExecution") return;
    const command = commandText(item.command);
    if (!command) return;
    calls.push({
      id: stringValue(item.id) ?? `codex-shell-${entryOffset + entryIndex}`,
      command,
      cwd: workingDirectory(item.cwd),
      output: joinedOutput(item),
      success: isSuccessful(item),
    });
  });

  return calls;
}

/** The item of an `item_completed` payload, or null for any other payload. */
export function completedItem(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  if (record?.type !== "item_completed") return null;
  return asRecord(record.item);
}

function isSuccessful(item: Record<string, unknown>): boolean {
  const exitCode = exitCodeOf(item.exit_code);
  if (exitCode !== null) return exitCode === 0;
  return item.status === "completed";
}

function exitCodeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) return Number(value.trim());
  return null;
}

/** Codex stores the working directory as a file URL; older records use a plain path. */
function workingDirectory(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  if (!raw.startsWith("file:")) return raw;
  try {
    return fileURLToPath(raw);
  } catch {
    return undefined;
  }
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.at(-1) ?? null;
}

function joinedOutput(item: Record<string, unknown>): string | null {
  const aggregated = stringValue(item.aggregated_output);
  if (aggregated) return aggregated;
  const parts = [item.stdout, item.stderr]
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
