/**
 * Claude-compatible transcript line helpers.
 *
 * Two line shapes exist in the wild for "Claude Code-compatible" JSONL:
 *
 *   A) top-level role (observed in Cursor IDE agent transcripts):
 *      {"role":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 *
 *   B) top-level type (Claude Code session files, Cursor CLI stream-json):
 *      {"type":"assistant","message":{"role":"assistant","content":[…]}}
 *
 * Accept both so stop-text recovery and mutation extraction survive format
 * drift between tools and versions.
 */

export interface TranscriptEntryLike {
  role?: unknown;
  type?: unknown;
  message?: { role?: unknown; content?: unknown } | null;
}

/** Resolve the conversational role of a transcript line, tolerating both shapes. */
export function transcriptEntryRole(entry: TranscriptEntryLike): string | undefined {
  if (typeof entry.role === "string") return entry.role;
  if (entry.type === "assistant" || entry.type === "user") return entry.type;
  const messageRole = entry.message?.role;
  return typeof messageRole === "string" ? messageRole : undefined;
}

/**
 * Extract joined text content from an assistant transcript line.
 * Returns undefined for non-assistant lines or lines without text blocks.
 */
export function assistantTextFromTranscriptEntry(entry: TranscriptEntryLike): string | undefined {
  if (transcriptEntryRole(entry) !== "assistant") return undefined;

  const content = entry.message?.content;
  if (!Array.isArray(content)) return undefined;

  const texts = content
    .filter((block): block is { type: string; text: string } =>
      !!block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .filter((text) => text.trim().length > 0);

  return texts.length > 0 ? texts.join("\n") : undefined;
}
