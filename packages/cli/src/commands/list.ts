/**
 * `adit timeline` — Show timeline entries.
 *
 * Displays a compact, token-efficient table of recent events.
 */

import { basename } from "node:path";
import { openDatabase, closeDatabase, countEvents, type AditEvent, type Actor, type EventType } from "@varveai/adit-core";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import { getEventSummary } from "../utils/summary.js";
import { createTimelineManager } from "@varveai/adit-engine";
import {
  dim,
  localDateTime,
  marks,
  printEnd,
  printTable,
  printTitle,
  shortId,
  strong,
  summaryColumns,
  truncate,
} from "./cli-style.js";

export type SortField = "ACTOR" | "TIME";

export interface ListCommandOptions {
  limit?: number;
  actor?: string;
  type?: string;
  query?: string;
  expand?: boolean;
  sort?: SortField;
  json?: boolean;
}

export async function listCommand(opts: ListCommandOptions): Promise<void> {
  const config = loadInitializedProjectConfig("adit timeline");
  if (!config) return;
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    let events: AditEvent[];

    if (opts.query) {
      events = await timeline.search(opts.query, opts.limit ?? 20);
    } else {
      events = await timeline.list({
        actor: opts.actor as Actor | undefined,
        eventType: opts.type as EventType | undefined,
        limit: opts.limit ?? 50,
      });
    }

    const filtered = Boolean(opts.query || opts.actor || opts.type);
    const scope = opts.query ? `matching "${opts.query}"` : opts.actor ? `actor ${opts.actor}` : opts.type ? `type ${opts.type}` : null;
    const projectName = basename(config.projectRoot);

    if (events.length === 0) {
      if (opts.json) {
        console.log("No events found.");
        return;
      }
      printTitle("Timeline", projectName, scope);
      printEnd(`${marks.skip} ${filtered ? "No events match" : "No events recorded yet"}`);
      return;
    }

    // Sort events — default is TIME (descending, most recent first)
    const sortField = opts.sort ?? "TIME";
    events = sortEvents(events, sortField);

    // JSON output
    if (opts.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }

    const limit = opts.limit ?? (opts.query ? 20 : 50);
    const total = filtered ? null : countEvents(db, config.projectId);
    const summaryWidth = opts.expand ? 200 : summaryColumns(64);
    printTitle("Timeline", projectName, scope, sortField === "TIME" ? "newest first" : "by actor");
    printTable(
      [{ header: "id" }, { header: "time" }, { header: "actor" }, { header: "type" }, { header: "summary" }],
      events.map((event) => [
        shortId(event.id),
        localDateTime(event.startedAt, { seconds: true }),
        event.actor,
        event.eventType,
        truncate(getEventSummary(event, 10_000), summaryWidth),
      ]),
    );

    const shown = total !== null ? `${events.length} of ${total}` : `${events.length} shown`;
    const more = total !== null && total > events.length
      ? `more: ${strong(`adit timeline --limit ${Math.min(total, Math.max(limit * 2, events.length + 20))}`)}`
      : null;
    printEnd(dim([shown, more, `details: ${strong("adit show <id>")}`].filter(Boolean).join(" · ")));
  } finally {
    closeDatabase(db);
  }
}

export function sortEvents(events: AditEvent[], field: SortField): AditEvent[] {
  const sorted = [...events];
  switch (field) {
    case "ACTOR":
      sorted.sort((a, b) => a.actor.localeCompare(b.actor));
      break;
    case "TIME":
    default:
      sorted.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      break;
  }
  return sorted;
}
