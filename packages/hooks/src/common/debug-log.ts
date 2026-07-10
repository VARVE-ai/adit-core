/**
 * Debug logging for hook troubleshooting.
 *
 * Writes JSONL entries to $TMPDIR/adit-hook-debug.jsonl only when
 * ADIT_DEBUG is enabled. Hook payloads contain prompt text and tool
 * I/O, so nothing is written in normal operation. The file is
 * truncated once it exceeds the size cap so a long-lived debug
 * session cannot grow it without bound.
 */

import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEBUG_LOG_PATH = join(tmpdir(), "adit-hook-debug.jsonl");

const MAX_DEBUG_LOG_BYTES = 5 * 1024 * 1024;

/** Whether hook debug logging is enabled via ADIT_DEBUG */
export function isDebugEnabled(): boolean {
  const value = process.env.ADIT_DEBUG;
  return !!value && value !== "false" && value !== "0";
}

/** Append a JSONL debug entry (no-op unless ADIT_DEBUG is set). */
export function debugLog(entry: Record<string, unknown>): void {
  if (!isDebugEnabled()) return;
  try {
    try {
      if (statSync(DEBUG_LOG_PATH).size > MAX_DEBUG_LOG_BYTES) {
        writeFileSync(DEBUG_LOG_PATH, "");
      }
    } catch {
      // File missing — appendFileSync below will create it.
    }
    appendFileSync(
      DEBUG_LOG_PATH,
      JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {
    // best-effort
  }
}
