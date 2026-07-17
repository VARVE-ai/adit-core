#!/usr/bin/env node

/**
 * One-off local repair for ADIT databases polluted by Claude-Mem observer sessions.
 *
 * Default mode is dry-run:
 *   node tools/repair-claude-mem-history.mjs --db /path/to/adit.sqlite
 *
 * Apply mode creates a same-directory backup first, then soft-deletes the
 * detected observer sessions/events and scrubs their large payload fields:
 *   node tools/repair-claude-mem-history.mjs --db /path/to/adit.sqlite --apply
 */

import { copyFileSync, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SUMMARY_PREFIX =
  "Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant.";

const CONTAMINATED_SESSION_CTE = `
WITH contaminated_sessions AS (
  SELECT DISTINCT e.session_id
  FROM events e
  JOIN sessions s ON s.id = e.session_id
  WHERE s.platform = 'claude-code'
    AND e.event_type = 'prompt_submit'
    AND e.prompt_text LIKE ${sqlString(`${SUMMARY_PREFIX}%`)}
    AND (
      e.prompt_text LIKE '%<observed_from_primary_session>%'
      OR e.prompt_text LIKE '%<user_request>%'
      OR e.prompt_text LIKE '%Hello memory agent%'
      OR e.prompt_text LIKE '%Claude-Mem%'
      OR e.prompt_text LIKE '%Tool executions include the working directory%'
      OR e.prompt_text LIKE '%OUTPUT FORMAT%'
      OR e.prompt_text LIKE '%<observation>%'
      OR (
        e.prompt_text LIKE '%Claude will see this summary when searching previous conversations for useful memories and information.%'
        AND e.prompt_text LIKE '%Part summaries:%'
      )
    )
)`;

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.dbPath) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

const dbPath = resolve(args.dbPath);
if (!existsSync(dbPath)) {
  fail(`Database not found: ${dbPath}`);
}

try {
  ensureSqlite();
  const before = collectReport(dbPath, args.limit);

  printReport(before, {
    dbPath,
    mode: args.apply ? "apply" : "dry-run",
    backupPath: null,
  });

  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to soft-delete these sessions/events.");
    process.exit(0);
  }

  if (before.stats.contaminatedSessions === 0) {
    console.log("\nNo contaminated sessions found. Nothing to apply.");
    process.exit(0);
  }

  const backupPath = backupDatabase(dbPath);
  const applied = applyRepair(dbPath, before.stats);
  console.log("\nApplied repair:");
  console.log(`  backup: ${backupPath}`);
  console.log(`  events soft-deleted: ${applied.eventsChanged}`);
  console.log(`  sessions soft-deleted: ${applied.sessionsChanged}`);
  console.log(`  event payloads scrubbed: ${applied.eventsScrubbed}`);
  console.log("\nNote: this repairs the local SQLite database only. Already-synced cloud rows are not cleaned by this script.");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function parseArgs(argv) {
  const parsed = {
    dbPath: "",
    apply: false,
    help: false,
    limit: 20,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") {
      parsed.dbPath = argv[++i] ?? "";
    } else if (arg === "--apply") {
      parsed.apply = true;
    } else if (arg === "--dry-run") {
      parsed.apply = false;
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInt(argv[++i], parsed.limit);
    } else if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node tools/repair-claude-mem-history.mjs --db /path/to/adit.sqlite [--dry-run]
  node tools/repair-claude-mem-history.mjs --db /path/to/adit.sqlite --apply

Options:
  --db <path>     SQLite database path.
  --apply         Create a backup and soft-delete detected Claude-Mem observer data.
  --dry-run       Report only. This is the default.
  --limit <n>     Number of needs-review user_request samples to print. Default: 20.
`);
}

function collectReport(dbPath, limit) {
  const stats = queryOneReadonly(dbPath, `
${CONTAMINATED_SESSION_CTE}
SELECT
  (SELECT COUNT(*) FROM contaminated_sessions) AS contaminatedSessions,
  (SELECT COUNT(*) FROM events e WHERE e.session_id IN contaminated_sessions) AS contaminatedEvents,
  (SELECT COUNT(*) FROM events e WHERE e.session_id IN contaminated_sessions AND e.deleted_at IS NULL) AS eventsToSoftDelete,
  (SELECT COUNT(*) FROM sessions s WHERE s.id IN contaminated_sessions AND s.deleted_at IS NULL) AS sessionsToSoftDelete,
  (SELECT COUNT(*) FROM events e WHERE e.session_id IN contaminated_sessions AND e.event_type = 'prompt_submit') AS contaminatedPrompts,
  (SELECT COUNT(*) FROM events e WHERE e.session_id IN contaminated_sessions AND (
    e.prompt_text IS NOT NULL OR e.response_text IS NOT NULL OR e.tool_input_json IS NOT NULL OR e.tool_output_json IS NOT NULL
  )) AS eventsToScrub,
  (SELECT COALESCE(SUM(
    length(COALESCE(e.prompt_text, '')) +
    length(COALESCE(e.response_text, '')) +
    length(COALESCE(e.tool_input_json, '')) +
    length(COALESCE(e.tool_output_json, ''))
  ), 0) FROM events e WHERE e.session_id IN contaminated_sessions) AS contaminatedBytes,
  (SELECT COALESCE(MAX(length(e.prompt_text)), 0) FROM events e WHERE e.session_id IN contaminated_sessions AND e.event_type = 'prompt_submit') AS maxPromptChars;
`);

  const userRequests = queryReadonly(dbPath, `
${CONTAMINATED_SESSION_CTE},
polluted_prompts AS (
  SELECT e.id AS event_id, e.session_id, s.project_id, e.prompt_text
  FROM events e
  JOIN sessions s ON s.id = e.session_id
  WHERE e.session_id IN contaminated_sessions
    AND e.event_type = 'prompt_submit'
),
extracted AS (
  SELECT
    event_id,
    session_id,
    project_id,
    trim(substr(
      prompt_text,
      instr(prompt_text, '<user_request>') + length('<user_request>'),
      instr(prompt_text, '</user_request>') - instr(prompt_text, '<user_request>') - length('<user_request>')
    )) AS user_request
  FROM polluted_prompts
  WHERE instr(prompt_text, '<user_request>') > 0
    AND instr(prompt_text, '</user_request>') > instr(prompt_text, '<user_request>')
)
SELECT
  x.event_id AS eventId,
  x.session_id AS sessionId,
  x.project_id AS projectId,
  x.user_request AS userRequest,
  CASE WHEN EXISTS (
    SELECT 1
    FROM events e2
    JOIN sessions s2 ON s2.id = e2.session_id
    WHERE s2.project_id = x.project_id
      AND e2.session_id NOT IN contaminated_sessions
      AND e2.event_type = 'prompt_submit'
      AND e2.prompt_text = x.user_request
      AND e2.deleted_at IS NULL
    LIMIT 1
  ) THEN 1 ELSE 0 END AS hasExactPromptMatch
FROM extracted x
WHERE x.user_request IS NOT NULL AND x.user_request != '';
`);

  const duplicateCount = userRequests.filter((row) => row.hasExactPromptMatch === 1).length;
  const needsReview = userRequests
    .filter((row) => row.hasExactPromptMatch !== 1)
    .map((row) => ({
      eventId: row.eventId,
      sessionId: row.sessionId,
      projectId: row.projectId,
      length: row.userRequest.length,
      sha256: sha256(row.userRequest),
      sample: row.userRequest.slice(0, 240),
    }));

  return {
    stats: {
      contaminatedSessions: Number(stats.contaminatedSessions ?? 0),
      contaminatedEvents: Number(stats.contaminatedEvents ?? 0),
      eventsToSoftDelete: Number(stats.eventsToSoftDelete ?? 0),
      sessionsToSoftDelete: Number(stats.sessionsToSoftDelete ?? 0),
      contaminatedPrompts: Number(stats.contaminatedPrompts ?? 0),
      eventsToScrub: Number(stats.eventsToScrub ?? 0),
      contaminatedBytes: Number(stats.contaminatedBytes ?? 0),
      maxPromptChars: Number(stats.maxPromptChars ?? 0),
      extractedUserRequests: userRequests.length,
      duplicateUserRequests: duplicateCount,
      needsReviewUserRequests: needsReview.length,
    },
    needsReview: needsReview.slice(0, limit),
    needsReviewLimit: limit,
  };
}

function printReport(report, context) {
  console.log(`ADIT Claude-Mem history repair (${context.mode})`);
  console.log(`Database: ${context.dbPath}`);
  console.log("");
  console.log("Detected:");
  console.log(`  contaminated sessions: ${report.stats.contaminatedSessions}`);
  console.log(`  contaminated events: ${report.stats.contaminatedEvents}`);
  console.log(`  events needing soft-delete: ${report.stats.eventsToSoftDelete}`);
  console.log(`  sessions needing soft-delete: ${report.stats.sessionsToSoftDelete}`);
  console.log(`  events needing payload scrub: ${report.stats.eventsToScrub}`);
  console.log(`  contaminated prompt events: ${report.stats.contaminatedPrompts}`);
  console.log(`  contaminated payload bytes: ${report.stats.contaminatedBytes}`);
  console.log(`  max prompt chars: ${report.stats.maxPromptChars}`);
  console.log("");
  console.log("Observed <user_request> salvage check:");
  console.log(`  extracted: ${report.stats.extractedUserRequests}`);
  console.log(`  exact matches already present: ${report.stats.duplicateUserRequests}`);
  console.log(`  needs review, not auto-inserted: ${report.stats.needsReviewUserRequests}`);

  if (report.needsReview.length > 0) {
    console.log(`\nNeeds-review samples (first ${report.needsReviewLimit}):`);
    for (const row of report.needsReview) {
      console.log(`- event=${row.eventId} session=${row.sessionId} length=${row.length} sha256=${row.sha256}`);
      console.log(`  ${row.sample.replace(/\s+/g, " ")}`);
    }
  }
}

function applyRepair(dbPath, stats) {
  const deletedAt = new Date().toISOString();
  runSqlite([dbPath], `
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS temp.adit_repair_contaminated_sessions;
CREATE TEMP TABLE adit_repair_contaminated_sessions AS
${CONTAMINATED_SESSION_CTE}
SELECT session_id FROM contaminated_sessions;

UPDATE events
SET deleted_at = COALESCE(deleted_at, ${sqlString(deletedAt)})
WHERE session_id IN (SELECT session_id FROM temp.adit_repair_contaminated_sessions)
  AND deleted_at IS NULL;

UPDATE sessions
SET
  deleted_at = COALESCE(deleted_at, ${sqlString(deletedAt)}),
  ended_at = COALESCE(ended_at, ${sqlString(deletedAt)}),
  status = 'completed'
WHERE id IN (SELECT session_id FROM temp.adit_repair_contaminated_sessions)
  AND deleted_at IS NULL;

UPDATE events
SET
  prompt_text = CASE
    WHEN prompt_text IS NULL THEN NULL
    WHEN event_type = 'prompt_submit' THEN '[ADIT repair] Claude-Mem observer prompt removed'
    ELSE NULL
  END,
  response_text = NULL,
  tool_input_json = '{"aditRepair":"claude-mem-observer-payload-removed","originalPromptLength":'
    || length(COALESCE(prompt_text, ''))
    || ',"originalResponseLength":'
    || length(COALESCE(response_text, ''))
    || ',"originalToolInputLength":'
    || length(COALESCE(tool_input_json, ''))
    || ',"originalToolOutputLength":'
    || length(COALESCE(tool_output_json, ''))
    || '}',
  tool_output_json = NULL
WHERE session_id IN (SELECT session_id FROM temp.adit_repair_contaminated_sessions)
  AND (
    prompt_text IS NOT NULL
    OR response_text IS NOT NULL
    OR tool_input_json IS NOT NULL
    OR tool_output_json IS NOT NULL
  );

DROP TABLE IF EXISTS temp.adit_repair_contaminated_sessions;
COMMIT;
`);

  return {
    eventsChanged: stats.eventsToSoftDelete,
    sessionsChanged: stats.sessionsToSoftDelete,
    eventsScrubbed: stats.eventsToScrub,
  };
}

function backupDatabase(dbPath) {
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const backupPath = resolve(dirname(dbPath), `${basename(dbPath)}.backup-${stamp}`);
  copyFileSync(dbPath, backupPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      copyFileSync(sidecar, `${backupPath}${suffix}`);
    }
  }
  return backupPath;
}

function queryReadonly(dbPath, sql) {
  try {
    return runSqliteJson(["-readonly", dbPath], sql);
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("unable to open database file")) {
      throw error;
    }
    return runSqliteJson([sqliteImmutableReadonlyUri(dbPath)], sql);
  }
}

function queryOneReadonly(dbPath, sql) {
  return queryReadonly(dbPath, sql)[0] ?? {};
}

function runSqliteJson(dbArgs, sql) {
  const output = execFileSync("sqlite3", ["-json", ...dbArgs], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 100 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function runSqlite(dbArgs, sql) {
  execFileSync("sqlite3", dbArgs, {
    input: sql,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

function sqliteImmutableReadonlyUri(dbPath) {
  return `${pathToFileURL(dbPath).href}?mode=ro&immutable=1`;
}

function ensureSqlite() {
  execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
