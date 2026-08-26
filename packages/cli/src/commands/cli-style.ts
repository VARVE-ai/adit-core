/**
 * Shared terminal style for adit CLI output — one color role per meaning:
 *
 *   marks.ok     green  [+]  newly done (installed, linked, created)
 *   marks.warn   yellow [!]  needs attention, not blocking
 *   marks.fail   red    [x]  failed
 *   marks.change cyan   [~]  intentional removal/change
 *   [=]          dim         unchanged/refreshed — dim the whole line
 *
 * Cyan is reserved for guidance (section titles, focus, "Next step"/"Tip"
 * labels); bold only for key values (project names, paths, commands).
 * Secondary detail (durations, counts, annotations) is dimmed.
 */

import pc from "picocolors";

export const marks = {
  ok: pc.green("[+]"),
  warn: pc.yellow("[!]"),
  fail: pc.red("[x]"),
  change: pc.cyan("[~]"),
} as const;

/** Section title — bold cyan, no underline rule. Caller supplies indent. */
export function sectionTitle(title: string): string {
  return pc.bold(pc.cyan(title));
}
