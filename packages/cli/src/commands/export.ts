/**
 * `adit export` — Export event data in various formats.
 *
 * Supports single-event bundles, full session exports,
 * JSONL streaming, markdown reports, and gzip compression.
 */

import { writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  openDatabase,
  closeDatabase,
  getEnvSnapshotById,
  getEventsBySession,
  getLatestSession,
  getSessionById,
  parseLabels,
  parseDiffStats,
  type AditEvent,
} from "@varveai/adit-core";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import { createTimelineManager } from "@varveai/adit-engine";

/** `adit export <id>` — export a single event bundle */
export async function exportCommand(
  eventId: string,
  opts: {
    output?: string;
  },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit export");
  if (!config) return;
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const event = await timeline.get(eventId);
    if (!event) {
      console.error(`Event not found: ${eventId}`);
      process.exit(1);
    }

    const diff = await timeline.getDiff(eventId);
    const envSnapshot = event.envSnapshotId
      ? getEnvSnapshotById(db, event.envSnapshotId)
      : null;

    const bundle = buildEventBundle(event, diff, envSnapshot);
    const output = JSON.stringify(bundle, null, 2);

    if (opts.output) {
      writeFileSync(opts.output, output);
      console.log(`Exported to ${opts.output}`);
    } else {
      console.log(output);
    }
  } finally {
    closeDatabase(db);
  }
}

/** `adit export session [session-id]` — export entire session */
export async function exportSessionCommand(
  sessionId?: string,
  opts?: {
    format?: string;
    output?: string;
    from?: string;
    to?: string;
    includeDiffs?: boolean;
    includeEnv?: boolean;
    gzip?: boolean;
  },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit export");
  if (!config) return;
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    let sid = sessionId;
    if (!sid) {
      const session = getLatestSession(db, config.projectId, config.clientId);
      if (!session) {
        console.error("No sessions found. Provide a session ID.");
        process.exit(1);
      }
      sid = session.id;
    }

    const session = getSessionById(db, sid!);
    if (!session) {
      console.error(`Session not found: ${sid}`);
      process.exit(1);
    }

    let events = getEventsBySession(db, sid!);

    // Date range filter
    if (opts?.from) {
      const fromDate = new Date(opts.from).toISOString();
      events = events.filter((e) => e.startedAt >= fromDate);
    }
    if (opts?.to) {
      const toDate = new Date(opts.to).toISOString();
      events = events.filter((e) => e.startedAt <= toDate);
    }

    const format = opts?.format ?? "json";

    if (format === "markdown") {
      const md = generateMarkdownReport(session, events);
      await outputResult(md, opts?.output, opts?.gzip);
    } else if (format === "jsonl") {
      const lines: string[] = [];
      // Header line
      lines.push(JSON.stringify({
        type: "session",
        id: session.id,
        platform: session.platform,
        startedAt: session.startedAt,
        lastActivityAt: events.at(-1)?.startedAt ?? session.startedAt,
      }));

      for (const event of events) {
        const diff = opts?.includeDiffs ? await timeline.getDiff(event.id) : null;
        const env = opts?.includeEnv && event.envSnapshotId
          ? getEnvSnapshotById(db, event.envSnapshotId)
          : null;
        lines.push(JSON.stringify({
          type: "event",
          ...buildEventBundle(event, diff ?? undefined, env),
        }));
      }

      await outputResult(lines.join("\n") + "\n", opts?.output, opts?.gzip);
    } else {
      // JSON
      const bundle = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        session: {
          id: session.id,
          platform: session.platform,
          startedAt: session.startedAt,
          lastActivityAt: events.at(-1)?.startedAt ?? session.startedAt,
        },
        events: events.map((e) => buildEventBundle(e, undefined, null)),
        eventCount: events.length,
      };

      await outputResult(JSON.stringify(bundle, null, 2), opts?.output, opts?.gzip);
    }

    if (opts?.output) {
      console.log(`Exported ${events.length} events to ${opts.output}${opts?.gzip ? ".gz" : ""}`);
    }
  } finally {
    closeDatabase(db);
  }
}

function buildEventBundle(
  event: AditEvent,
  diff?: string | null,
  envSnapshot?: { gitBranch: string; gitHeadSha: string; nodeVersion: string | null; pythonVersion: string | null; osInfo: string | null; depLockPath: string | null; depLockHash: string | null } | null,
): Record<string, unknown> {
  return {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    event: {
      id: event.id,
      sessionId: event.sessionId,
      sequence: event.sequence,
      eventType: event.eventType,
      actor: event.actor,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      status: event.status,
      gitBranch: event.gitBranch,
      gitHeadSha: event.gitHeadSha,
      labels: parseLabels(event.labelsJson),
      fileStats: parseDiffStats(event.diffStatJson),
    },
    prompt: event.promptText ?? null,
    chainOfThought: event.cotText ?? null,
    response: event.responseText ?? null,
    tool: event.toolName
      ? {
          name: event.toolName,
          input: event.toolInputJson ? JSON.parse(event.toolInputJson) : null,
          output: event.toolOutputJson ? JSON.parse(event.toolOutputJson) : null,
        }
      : null,
    diff: diff ?? null,
    environment: envSnapshot
      ? {
          gitBranch: envSnapshot.gitBranch,
          gitHeadSha: envSnapshot.gitHeadSha,
          nodeVersion: envSnapshot.nodeVersion,
          pythonVersion: envSnapshot.pythonVersion,
          osInfo: envSnapshot.osInfo,
          depLockPath: envSnapshot.depLockPath,
          depLockHash: envSnapshot.depLockHash,
        }
      : null,
  };
}

function generateMarkdownReport(
  session: { id: string; platform: string; startedAt: string },
  events: AditEvent[],
): string {
  const lines: string[] = [];
  lines.push(`# ADIT Session Export`);
  lines.push("");
  lines.push(`- **Session**: ${session.id}`);
  lines.push(`- **Platform**: ${session.platform}`);
  lines.push(`- **Started**: ${session.startedAt}`);
  lines.push(`- **Last activity**: ${events.at(-1)?.startedAt ?? session.startedAt}`);
  lines.push(`- **Events**: ${events.length}`);
  lines.push("");
  lines.push("## Timeline");
  lines.push("");

  for (const event of events) {
    const time = event.startedAt.substring(5, 19).replace("T", " ");
    const actor = event.actor[0].toUpperCase();
    lines.push(`### ${time} [${actor}] ${event.eventType}`);
    lines.push("");

    if (event.promptText) {
      lines.push(`> ${event.promptText.substring(0, 500)}`);
      lines.push("");
    }
    if (event.toolName) {
      lines.push(`**Tool**: ${event.toolName}`);
      lines.push("");
    }
    if (event.responseText) {
      lines.push(`${event.responseText.substring(0, 500)}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function outputResult(
  content: string,
  outputPath?: string,
  gzip?: boolean,
): Promise<void> {
  if (!outputPath) {
    console.log(content);
    return;
  }

  if (gzip) {
    const gzipPath = outputPath.endsWith(".gz") ? outputPath : `${outputPath}.gz`;
    const readable = Readable.from([content]);
    const gzipStream = createGzip();
    const writable = createWriteStream(gzipPath);
    await pipeline(readable, gzipStream, writable);
  } else {
    writeFileSync(outputPath, content);
  }
}
