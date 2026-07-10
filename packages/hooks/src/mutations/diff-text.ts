/**
 * Build bounded unified diff_text for diffs.diff_text from mutations.
 *
 * Each mutation contributes a `diff --git` segment. Mutations that exceeded
 * the per-file cap (omitted.reason === "diff_too_large") contribute a
 * placeholder header without the body.
 *
 * The whole payload is bounded by MAX_EVENT_DIFF_BYTES; if total exceeds,
 * remaining mutations are summed into a final truncation marker.
 */

import type { AgentFileMutation } from "./types.js";
import { EVENT_DIFF_LIMIT } from "./extract.js";

export function buildBoundedDiffText(mutations: AgentFileMutation[]): string {
  const segments: string[] = [];
  let totalBytes = 0;
  let truncated = 0;

  for (const m of mutations) {
    // Normalize path separators for diff headers (Windows safety). Originals
    // from JSONL may be either POSIX or Windows depending on host OS.
    const path = m.path.replace(/\\/g, "/");
    const header =
      `diff --git a/${path} b/${path}\n` +
      `--- a/${path}\n` +
      `+++ b/${path}\n`;

    let body: string;
    if (m.diff) {
      body = m.diff;
    } else if (m.omitted) {
      const bytes = m.omitted.bytes !== undefined ? ` (${m.omitted.bytes} bytes)` : "";
      body = `# diff omitted: ${m.omitted.reason}${bytes}`;
    } else {
      continue;
    }

    const segment = header + body + "\n";
    if (totalBytes + segment.length > EVENT_DIFF_LIMIT) {
      truncated += 1;
      continue;
    }
    segments.push(segment);
    totalBytes += segment.length;
  }

  if (truncated > 0) {
    segments.push(
      `# ${truncated} additional mutation(s) truncated; event diff exceeded ${EVENT_DIFF_LIMIT} bytes\n`,
    );
  }

  return segments.join("");
}
