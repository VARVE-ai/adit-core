/**
 * `adit show <id>` — Show full event details.
 *
 * Accepts a full event ID or the 10-character prefix the timeline prints.
 */

import pc from "picocolors";
import {
  openDatabase,
  closeDatabase,
  parseLabels,
  parseDiffStats,
  parseError,
} from "@varveai/adit-core";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import { createTimelineManager } from "@varveai/adit-engine";
import {
  dim,
  formatDuration,
  joinParts,
  localDateTime,
  marks,
  plural,
  printEnd,
  printLine,
  printRows,
  printSection,
  printTitle,
  shortId,
  stateWord,
  strong,
  type Row,
} from "./cli-style.js";
import { resolveLocalIdOrReport } from "./local-ids.js";

const DIFF_PREVIEW_LINES = 50;

export async function showCommand(eventId: string): Promise<void> {
  const config = loadInitializedProjectConfig("adit show");
  if (!config) return;
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const id = resolveLocalIdOrReport(db, "events", eventId, "show", `find IDs with ${strong("adit timeline")}`);
    if (!id) return;
    const event = await timeline.get(id);
    if (!event) return;

    const short = shortId(event.id);
    const durationMs = event.endedAt ? Date.parse(event.endedAt) - Date.parse(event.startedAt) : 0;
    const rows: Row[] = [
      { label: "Actor", value: event.actor },
      { label: "Session", value: joinParts([strong(shortId(event.sessionId)), `sequence ${event.sequence}`]) },
      {
        label: "Time",
        value: joinParts([
          localDateTime(event.startedAt, { seconds: true }),
          durationMs >= 1000 ? formatDuration(durationMs) : null,
        ]),
      },
      { label: "Status", value: stateWord(event.status) },
      { label: "Branch", value: joinParts([event.gitBranch ?? "-", event.gitHeadSha ? shortId(event.gitHeadSha) : null]) },
    ];

    const labels = parseLabels(event.labelsJson);
    if (labels.length > 0) rows.push({ label: "Labels", value: labels.join(", ") });

    const error = parseError(event.errorJson);
    if (error) rows.push({ label: "Error", value: `${marks.fail} [${error.category}] ${error.message}` });

    const stats = parseDiffStats(event.diffStatJson);
    if (stats.length > 0) {
      const files = stats.map((file) => {
        const adds = file.additions !== undefined ? pc.green(`+${file.additions}`) : "";
        const dels = file.deletions !== undefined ? pc.red(`-${file.deletions}`) : "";
        return [`${file.status} ${file.path}`, adds, dels].filter(Boolean).join(" ");
      });
      rows.push({
        label: "Files",
        value: stats.length === 1 ? `1 changed ${dim("·")} ${files[0]}` : [`${stats.length} changed`, ...files].join("\n"),
      });
    }

    printTitle("Event", short, event.eventType);
    printRows(rows);

    if (event.promptText) {
      printSection("Prompt");
      printLine(event.promptText);
    }
    if (event.cotText) {
      printSection("Chain of thought");
      printLine(event.cotText);
    }
    if (event.responseText) {
      printSection("Response");
      printLine(event.responseText);
    }
    if (event.toolName) {
      printSection("Tool", event.toolName);
      const toolRows: Row[] = [];
      if (event.toolInputJson) toolRows.push({ label: "Input", value: event.toolInputJson });
      if (event.toolOutputJson) toolRows.push({ label: "Output", value: event.toolOutputJson });
      printRows(toolRows);
    }

    const diff = await timeline.getDiff(event.id, DIFF_PREVIEW_LINES);
    let diffCut = false;
    if (diff) {
      const lines = diff.split("\n");
      diffCut = lines.length >= DIFF_PREVIEW_LINES;
      printSection("Diff", diffCut ? `first ${DIFF_PREVIEW_LINES} lines` : plural(lines.length, "line"));
      printLine(lines.map(colorDiffLine).join("\n"));
    }

    const hints = [
      event.promptText ? `full prompt: ${strong(`adit prompt ${short}`)}` : null,
      diffCut ? `full diff: ${strong(`adit snapshot diff ${short}`)}` : null,
    ];
    printEnd(hints.some(Boolean) ? dim(joinParts(hints)) : undefined);
  } finally {
    closeDatabase(db);
  }
}

function colorDiffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) return dim(line);
  if (line.startsWith("@@")) return pc.cyan(line);
  if (line.startsWith("+")) return pc.green(line);
  if (line.startsWith("-")) return pc.red(line);
  return line;
}
