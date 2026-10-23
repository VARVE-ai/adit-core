/**
 * `adit perf` — Performance stats for time-sensitive operations.
 *
 * Reads daily JSONL perf logs from the project runtime perf-logs directory and generates
 * an aggregated stats report showing call counts, timing distributions,
 * and failure rates.
 */

import {
  readPerfLogs,
  generatePerfStats,
  clearPerfLogs,
  type PerfStatsReport,
} from "@varveai/adit-core";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import { arrow, dim, formatCount, marks, printEnd, printTable, printTitle, strong } from "./cli-style.js";

/** Show performance stats report */
export function perfCommand(opts?: {
  from?: string;
  to?: string;
  category?: string;
  json?: boolean;
}): void {
  const config = loadInitializedProjectConfig("adit perf");
  if (!config) return;
  const entries = readPerfLogs(config.dataDir, opts?.from, opts?.to);

  // Filter by category if specified
  const filtered = opts?.category
    ? entries.filter((e) => e.category === opts.category)
    : entries;

  const report = generatePerfStats(filtered);

  if (opts?.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}

/** Clear all performance logs */
export function perfClearCommand(opts?: { json?: boolean }): void {
  const config = loadInitializedProjectConfig("adit perf");
  if (!config) return;
  const deleted = clearPerfLogs(config.dataDir);

  if (opts?.json) {
    console.log(JSON.stringify({ cleared: deleted }));
    return;
  }

  if (deleted === 0) {
    console.log("No performance logs to clear.");
  } else {
    console.log(`Cleared ${deleted} log file${deleted === 1 ? "" : "s"}.`);
  }
}

/** Print a formatted stats report to the terminal */
function printReport(report: PerfStatsReport): void {
  if (report.totalEntries === 0) {
    printTitle("Performance");
    printEnd(`${marks.skip} No performance data yet · logs are stored per project runtime`);
    return;
  }

  printTitle("Performance", `${report.fromDate} ${arrow()} ${report.toDate}`, `${formatCount(report.totalEntries)} calls`);
  printTable(
    [
      { header: "category" },
      { header: "operation" },
      { header: "count", align: "right" },
      { header: "avg", align: "right" },
      { header: "p95", align: "right" },
      { header: "max", align: "right" },
      { header: "fail", align: "right" },
    ],
    report.operations.map((op) => [
      op.category,
      op.operation,
      String(op.count),
      formatMs(op.avgMs),
      formatMs(op.p95Ms),
      formatMs(op.maxMs),
      op.failures > 0 ? String(op.failures) : "-",
    ]),
  );
  printEnd(dim(`min and stddev: ${strong("adit debug perf stats --json")}`));
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}
