/**
 * `adit search` — Search events with filters.
 */

import {
  openDatabase,
  closeDatabase,
  type AditEvent,
  type EventType,
} from "@varveai/adit-core";
import { basename } from "node:path";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import { getEventSummary } from "../utils/summary.js";
import { createTimelineManager } from "@varveai/adit-engine";
import {
  dim,
  highlight,
  localDateTime,
  marks,
  plural,
  printEnd,
  printTable,
  printTitle,
  shortId,
  strong,
  summaryColumns,
  truncate,
} from "./cli-style.js";

/** `adit search <query>` — search events with advanced filters */
export async function searchCommand(
  query: string,
  opts: {
    limit?: number;
    actor?: string;
    type?: string;
    from?: string;
    to?: string;
    branch?: string;
    format?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit search");
  if (!config) return;
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    let events = await timeline.search(query, opts.limit ?? 100);

    if (opts.actor) {
      events = events.filter((e) => e.actor === opts.actor);
    }
    if (opts.type) {
      events = events.filter((e) => e.eventType === (opts.type as EventType));
    }
    if (opts.from) {
      const fromDate = new Date(opts.from).toISOString();
      events = events.filter((e) => e.startedAt >= fromDate);
    }
    if (opts.to) {
      const toDate = new Date(opts.to).toISOString();
      events = events.filter((e) => e.startedAt <= toDate);
    }
    if (opts.branch) {
      events = events.filter((e) => e.gitBranch === opts.branch);
    }

    events = events.slice(0, opts.limit ?? 20);

    if (opts.format === "json" || opts.json) {
      console.log(JSON.stringify(events.map(formatEventSummary), null, 2));
      return;
    }

    const projectName = basename(config.projectRoot);
    if (events.length === 0) {
      printTitle("Search", `"${query}"`, projectName);
      printEnd(`${marks.skip} No events match`);
      return;
    }

    const limit = opts.limit ?? 20;
    const width = summaryColumns(43);
    printTitle("Search", `"${query}"`, projectName, plural(events.length, "match", "matches"));
    printTable(
      [{ header: "id" }, { header: "time" }, { header: "actor" }, { header: "summary" }],
      events.map((event) => [
        shortId(event.id),
        localDateTime(event.startedAt, { seconds: true }),
        event.actor,
        summaryCell(event, query, width),
      ]),
    );
    const more = events.length >= limit ? `more: ${strong(`adit search "${query}" --limit ${limit * 2}`)}` : null;
    printEnd(dim([`${events.length} shown`, more, `details: ${strong("adit show <id>")}`].filter(Boolean).join(" · ")));
  } finally {
    closeDatabase(db);
  }
}

/** The summary cut to the column, with the search words highlighted and labels appended. */
function summaryCell(event: AditEvent, query: string, width: number): string {
  const labels = parseLabelList(event.labelsJson);
  const text = truncate(getEventSummary(event, 10_000), width);
  const words = query.trim().split(/\s+/u).filter(Boolean).map(escapeRegExp);
  const marked = words.length > 0 ? text.replace(new RegExp(`(${words.join("|")})`, "giu"), (match) => highlight(match)) : text;
  return labels.length > 0 ? `${marked} ${dim(labels.map((label) => `[${label}]`).join(""))}` : marked;
}

function parseLabelList(json: string | null): string[] {
  if (!json) return [];
  try {
    const labels = JSON.parse(json) as unknown;
    return Array.isArray(labels) ? labels.filter((label): label is string => typeof label === "string") : [];
  } catch {
    return [];
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function formatEventSummary(event: AditEvent): Record<string, unknown> {
  return {
    id: event.id,
    eventType: event.eventType,
    actor: event.actor,
    startedAt: event.startedAt,
    gitBranch: event.gitBranch,
    labels: event.labelsJson ? JSON.parse(event.labelsJson) : [],
    snippet: getEventSummary(event, 200),
  };
}
