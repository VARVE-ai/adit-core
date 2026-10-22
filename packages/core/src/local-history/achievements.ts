import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { LocalStateError, type LocalWorkspace } from "../local-state.js";
import { analyticsSessions } from "./analytics-scope.js";
import { NON_MERGE_COMMIT_SQL } from "./commit-policy.js";
import { redactOverview } from "./analytics.js";
import { commandExecutions, COMMAND_PARSER_VERSION } from "./achievement-commands.js";
import { promptSummary } from "./prompt-summary.js";
import {
  ACHIEVEMENT_VERSION,
  achievementRules,
  achievementMetrics,
  localDay,
  type AchievementEvidence,
  type AchievementKey,
  type AchievementInterval,
} from "./achievement-rules.js";

type Row = Record<string, any>;
const digest = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
export interface AchievementExportOptions {
  selected: boolean;
  style: "plain" | "rich";
  showValue: boolean;
  showDate: boolean;
  showAgent: boolean;
  showPrompt: boolean;
}
export interface AchievementItem {
  key: AchievementKey;
  value: number | null;
  current: number | null;
  bestAt: number | null;
  tier: number;
  incomplete: number;
  unlocks: {
    id: string;
    tier: number;
    at: number | null;
    discoveredAt: number;
    unread: boolean;
  }[];
  evidence: (AchievementEvidence & {
    prompt: string | null;
    messages: number | null;
  })[];
  options: AchievementExportOptions;
}
export interface AchievementsData {
  workspaceId: string;
  workspaceName: string;
  repositories: number;
  timezone: string;
  status: "pending" | "ready" | "failed";
  evaluatedAt: number | null;
  firstAt: number | null;
  sourceErrors: number;
  error: string | null;
  revision: string | null;
  notify: boolean;
  unread: number;
  backfillCount: number;
  items: AchievementItem[];
}
const defaultOptions: AchievementExportOptions = {
  selected: false,
  style: "plain",
  showValue: true,
  showDate: true,
  showAgent: false,
  showPrompt: false,
};

export class LocalAchievements {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS adit_achievement_definitions (
        achievement_key TEXT NOT NULL,tier INTEGER NOT NULL,rule_version INTEGER NOT NULL,threshold INTEGER NOT NULL,metric_unit TEXT NOT NULL,
        PRIMARY KEY(achievement_key,tier,rule_version));
      CREATE TABLE IF NOT EXISTS adit_achievement_evaluations (
        workspace_id TEXT PRIMARY KEY,id TEXT NOT NULL,input_revision TEXT NOT NULL,scope_revision TEXT NOT NULL,rule_version INTEGER NOT NULL,
        timezone TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,first_at INTEGER,source_errors INTEGER NOT NULL DEFAULT 0,error TEXT,backfill_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS adit_achievement_progress (
        workspace_id TEXT NOT NULL,achievement_key TEXT NOT NULL,evaluation_id TEXT NOT NULL,current_value REAL NOT NULL,best_value REAL NOT NULL,
        best_at INTEGER,highest_tier INTEGER NOT NULL,incomplete INTEGER NOT NULL,evaluated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,achievement_key));
      CREATE TABLE IF NOT EXISTS adit_achievement_unlocks (
        id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,achievement_key TEXT NOT NULL,tier INTEGER NOT NULL,achieved_at INTEGER,
        discovered_at INTEGER NOT NULL,rule_version INTEGER NOT NULL,evaluation_id TEXT NOT NULL,valid INTEGER NOT NULL,notified_at INTEGER,acknowledged_at INTEGER,
        UNIQUE(workspace_id,achievement_key,tier));
      CREATE INDEX IF NOT EXISTS adit_achievement_unread ON adit_achievement_unlocks(workspace_id,acknowledged_at,discovered_at);
      CREATE TABLE IF NOT EXISTS adit_achievement_evidence (
        workspace_id TEXT NOT NULL,achievement_key TEXT NOT NULL,tier INTEGER NOT NULL,ordinal INTEGER NOT NULL,
        provider TEXT,session_id TEXT,turn_id TEXT,tool_call_id TEXT,repository TEXT,commit_sha TEXT,started_at INTEGER,ended_at INTEGER,value REAL,time_source TEXT,
        PRIMARY KEY(workspace_id,achievement_key,tier,ordinal));
      CREATE INDEX IF NOT EXISTS adit_achievement_evidence_session ON adit_achievement_evidence(provider,session_id);
      CREATE TABLE IF NOT EXISTS adit_achievement_preferences (workspace_id TEXT PRIMARY KEY,notify_enabled INTEGER NOT NULL DEFAULT 1,timezone TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adit_achievement_export_items (
        workspace_id TEXT NOT NULL,achievement_key TEXT NOT NULL,selected INTEGER NOT NULL,style TEXT NOT NULL,show_value INTEGER NOT NULL,
        show_date INTEGER NOT NULL,show_agent INTEGER NOT NULL,show_prompt INTEGER NOT NULL,PRIMARY KEY(workspace_id,achievement_key));
      CREATE TABLE IF NOT EXISTS adit_achievement_command_revisions (
        provider TEXT NOT NULL,session_id TEXT NOT NULL,revision INTEGER NOT NULL,parser_version INTEGER NOT NULL,incomplete INTEGER NOT NULL,
        PRIMARY KEY(provider,session_id),FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS adit_history_command_executions (
        provider TEXT NOT NULL,session_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,ordinal INTEGER NOT NULL,turn_id TEXT,occurred_at INTEGER,dedup_key TEXT NOT NULL,
        PRIMARY KEY(provider,session_id,tool_call_id,ordinal),FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS adit_command_execution_scope ON adit_history_command_executions(provider,session_id,occurred_at);
      CREATE TEMP TABLE IF NOT EXISTS achievement_scope(provider TEXT,id TEXT,PRIMARY KEY(provider,id));
    `);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO adit_achievement_definitions VALUES (?,?,?,?,?)",
    );
    db.transaction(() => {
      for (const r of achievementRules)
        r.thresholds.forEach((threshold, i) =>
          insert.run(r.key, i + 1, ACHIEVEMENT_VERSION, threshold, r.unit),
        );
    })();
  }

  private commands(sessions: ReturnType<typeof analyticsSessions>) {
    const calls = this.db
      .prepare(`SELECT c.*,r.content_text,r.status AS result_status,r.exit_code FROM adit_history_tool_calls c
      LEFT JOIN adit_history_tool_results r ON r.id=(SELECT r2.id FROM adit_history_tool_results r2 WHERE r2.tool_call_id=c.id ORDER BY r2.occurred_at DESC LIMIT 1)
      WHERE c.provider=? AND c.session_id=?`);
    for (const s of sessions) {
      const old = this.db
        .prepare(
          "SELECT revision,parser_version FROM adit_achievement_command_revisions WHERE provider=? AND session_id=?",
        )
        .get(s.provider, s.id) as Row | undefined;
      if (
        old?.revision === s.transcript_revision &&
        old.parser_version === COMMAND_PARSER_VERSION
      )
        continue;
      this.db
        .prepare(
          "DELETE FROM adit_history_command_executions WHERE provider=? AND session_id=?",
        )
        .run(s.provider, s.id);
      let incomplete = 0;
      for (const c of calls.all(s.provider, s.id) as Row[]) {
        const result = commandExecutions({
          name: c.tool_name,
          command: c.command_text,
          input: c.input_json,
          result: c.content_text,
          resultStatus: c.result_status,
          exitCode: c.exit_code,
        });
        incomplete += Number(result.incomplete);
        for (let i = 0; i < result.count; i++)
          this.db
            .prepare(
              "INSERT INTO adit_history_command_executions VALUES (?,?,?,?,?,?,?)",
            )
            .run(
              s.provider,
              s.id,
              c.id,
              i,
              c.turn_id,
              c.occurred_at,
              digest([
                s.provider,
                c.source_call_id || c.id,
                digest(c.input_json),
                i,
              ]),
            );
      }
      this.db
        .prepare(
          "INSERT OR REPLACE INTO adit_achievement_command_revisions VALUES (?,?,?,?,?)",
        )
        .run(
          s.provider,
          s.id,
          s.transcript_revision,
          COMMAND_PARSER_VERSION,
          incomplete,
        );
    }
  }

  evaluate(
    workspace: LocalWorkspace,
    options: { now?: number; timezone?: string; sourceErrors?: number } = {},
  ) {
    const now = options.now ?? Date.now();
    try {
      return this.db
        .transaction(() => {
          const preference = this.db
            .prepare(
              "SELECT * FROM adit_achievement_preferences WHERE workspace_id=?",
            )
            .get(workspace.id) as Row | undefined;
          const timezone =
            options.timezone ||
            preference?.timezone ||
            Intl.DateTimeFormat().resolvedOptions().timeZone;
          const day = localDay(now, timezone);
          const sessions = analyticsSessions(this.db, workspace)
            .filter((s) => !s.parent_id || s.relationship === "fork" || s.relationship === "continuation")
            .sort((a, b) =>
              (a.provider + a.id).localeCompare(b.provider + b.id),
            );
          const run = this.db
            .prepare(
              "SELECT id,finished_at FROM adit_attribution_runs WHERE workspace_id=? AND status='done' ORDER BY started_at DESC LIMIT 1",
            )
            .get(workspace.id) as Row | undefined;
          const commits = workspace.repositories.length
            ? (this.db
                .prepare(
                  `SELECT c.*,a.submit_provider,a.submit_session_id,a.submit_turn_id,a.submit_tool_call_id,a.match_method,
          tc.occurred_at AS operation_at FROM adit_local_commits c LEFT JOIN adit_attribution_commits a ON a.repository=c.repository AND a.sha=c.sha AND a.run_id=?
          LEFT JOIN adit_history_tool_calls tc ON tc.id=a.submit_tool_call_id
          WHERE c.repository IN (${workspace.repositories.map(() => "?").join(",")}) AND ${NON_MERGE_COMMIT_SQL}`,
                )
                .all(run?.id || "", ...workspace.repositories) as Row[])
            : [];
          const scope = digest([
            workspace.path,
            [...workspace.providers].sort(),
            [...workspace.repositories].sort(),
            timezone,
          ]);
          const input = digest([
            scope,
            day,
            ACHIEVEMENT_VERSION,
            COMMAND_PARSER_VERSION,
            sessions,
            run,
            commits.map((c) => [
              c.repository,
              c.sha,
              c.committed_at,
              c.submit_provider,
              c.submit_session_id,
              c.operation_at,
            ]),
            options.sourceErrors || 0,
          ]);
          const old = this.db
            .prepare(
              "SELECT * FROM adit_achievement_evaluations WHERE workspace_id=?",
            )
            .get(workspace.id) as Row | undefined;
          if (old?.input_revision === input && old.status === "ready")
            return { cached: true };
          this.db
            .prepare(
              "INSERT OR IGNORE INTO adit_achievement_preferences VALUES (?,1,?)",
            )
            .run(workspace.id, timezone);
          this.db
            .prepare(
              "UPDATE adit_achievement_preferences SET timezone=? WHERE workspace_id=?",
            )
            .run(timezone, workspace.id);
          this.db.prepare("DELETE FROM achievement_scope").run();
          const add = this.db.prepare(
            "INSERT INTO achievement_scope VALUES (?,?)",
          );
          for (const s of sessions) add.run(s.provider, s.id);
          this.commands(sessions);
          const join =
            "JOIN achievement_scope q ON q.provider=t.provider AND q.id=t.session_id";
          const intervals = this.db
            .prepare(
              `SELECT i.started_at AS at,i.counted_duration_ms AS duration,t.provider,t.session_id AS sessionId,t.id AS turnId FROM adit_history_work_intervals i JOIN adit_history_turns t ON t.id=i.turn_id ${join}`,
            )
            .all() as AchievementInterval[];
          const prompts = this.db
            .prepare(
              `SELECT t.started_at AS at,t.provider,t.session_id AS sessionId,t.id AS turnId FROM adit_history_turns t ${join}`,
            )
            .all() as AchievementEvidence[];
          const commands = this.db
            .prepare(
              `SELECT t.*,t.session_id AS sessionId,t.tool_call_id AS toolId,t.turn_id AS turnId,t.occurred_at AS at FROM adit_history_command_executions t ${join} ORDER BY t.occurred_at`,
            )
            .all() as Row[];
          const uniqueCommands = [
            ...new Map(commands.map((c) => [c.dedup_key, c])).values(),
          ] as AchievementEvidence[];
          const incompleteCommands = (
            this.db
              .prepare(
                `SELECT coalesce(sum(t.incomplete),0) AS n FROM adit_achievement_command_revisions t ${join}`,
              )
              .get() as Row
          ).n;
          const incompleteTime = (
            this.db
              .prepare(
                `SELECT count(*) AS n FROM adit_history_turns t ${join} WHERE t.duration_status<>'observed'`,
              )
              .get() as Row
          ).n;
          const main = new Set(sessions.map((s) => s.provider + ":" + s.id));
          const conversationIds=new Map(sessions.map(s=>[s.provider+":"+s.id,s.conversation_id]));
          const grouped = new Map<string, Row[]>();
          for (const c of commits)
            grouped.set(c.sha, [...(grouped.get(c.sha) || []), c]);
          const submissions: AchievementEvidence[] = [];
          let missingCommits = 0;
          for (const copies of grouped.values()) {
            const ids = new Set(
              copies
                .filter((c) => c.submit_session_id)
                .map((c) => c.submit_provider + ":" + (conversationIds.get(c.submit_provider+":"+c.submit_session_id)||c.submit_session_id)),
            );
            const c = copies.find((c) =>
              main.has(c.submit_provider + ":" + c.submit_session_id),
            );
            if (ids.size !== 1 || !c) {
              missingCommits++;
              continue;
            }
            submissions.push({
              provider: c.submit_provider,
              sessionId: conversationIds.get(c.submit_provider+":"+c.submit_session_id)||c.submit_session_id,
              turnId: c.submit_turn_id,
              toolId: c.submit_tool_call_id,
              repository: c.repository,
              sha: c.sha,
              at: c.operation_at ?? c.committed_at,
              timeSource: c.operation_at != null ? "command" : "git",
            });
          }
          const metrics = achievementMetrics({
            intervals,
            prompts,
            commands: uniqueCommands,
            commits: submissions,
            timezone,
            now,
            incompleteTime,
            incompleteCommands,
          });
          metrics.shipper.incomplete = missingCommits;
          const evaluation = randomUUID();
          this.db
            .prepare(
              "UPDATE adit_achievement_unlocks SET valid=0 WHERE workspace_id=?",
            )
            .run(workspace.id);
          this.db
            .prepare(
              "DELETE FROM adit_achievement_evidence WHERE workspace_id=?",
            )
            .run(workspace.id);
          const evidence = (
            key: string,
            tier: number,
            items: AchievementEvidence[],
          ) =>
            items.forEach((e, i) =>
              this.db
                .prepare(
                  "INSERT INTO adit_achievement_evidence VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                )
                .run(
                  workspace.id,
                  key,
                  tier,
                  i,
                  e.provider ?? null,
                  e.sessionId ?? null,
                  e.turnId ?? null,
                  e.toolId ?? null,
                  e.repository ?? null,
                  e.sha ?? null,
                  e.at,
                  e.endAt ?? null,
                  e.value ?? null,
                  e.timeSource ?? "events",
                ),
            );
          for (const rule of achievementRules) {
            const m = metrics[rule.key];
            this.db
              .prepare(
                "INSERT OR REPLACE INTO adit_achievement_progress VALUES (?,?,?,?,?,?,?,?,?)",
              )
              .run(
                workspace.id,
                rule.key,
                evaluation,
                m.current,
                m.value,
                m.bestAt,
                m.tiers.length,
                m.incomplete,
                now,
              );
            evidence(rule.key, 0, m.evidence);
            for (const tier of m.tiers) {
              this.db
                .prepare(
                  `INSERT INTO adit_achievement_unlocks VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,achievement_key,tier) DO UPDATE SET
              achieved_at=excluded.achieved_at,rule_version=excluded.rule_version,evaluation_id=excluded.evaluation_id,valid=1`,
                )
                .run(
                  randomUUID(),
                  workspace.id,
                  rule.key,
                  tier.tier,
                  tier.at,
                  now,
                  ACHIEVEMENT_VERSION,
                  evaluation,
                  1,
                  null,
                  preference?.notify_enabled === 0 ? now : null,
                );
              evidence(rule.key, tier.tier, tier.evidence);
            }
          }
          const firstAt = prompts.reduce<number | null>(
            (first, p) =>
              p.at === null
                ? first
                : first === null
                  ? p.at
                  : Math.min(first, p.at),
            null,
          );
          this.db
            .prepare(
              "INSERT OR REPLACE INTO adit_achievement_evaluations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              workspace.id,
              evaluation,
              input,
              scope,
              ACHIEVEMENT_VERSION,
              timezone,
              "ready",
              now,
              now,
              firstAt,
              options.sourceErrors || 0,
              null,
              old?.finished_at
                ? old.backfill_count
                : Object.values(metrics).filter((m) => m.tiers.length).length,
            );
          return { cached: false };
        })
        .immediate();
    } catch (error) {
      this.db
        .prepare(
          `INSERT INTO adit_achievement_evaluations (workspace_id,id,input_revision,scope_revision,rule_version,timezone,status,started_at,error)
        VALUES (?,?,'','',?,?, 'failed',?,?) ON CONFLICT(workspace_id) DO UPDATE SET status='failed',error=excluded.error`,
        )
        .run(
          workspace.id,
          randomUUID(),
          ACHIEVEMENT_VERSION,
          options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
          now,
          "Achievement evaluation failed; previous results retained",
        );
      throw error;
    }
  }

  read(workspace: LocalWorkspace): AchievementsData {
    const e = this.db
      .prepare(
        "SELECT * FROM adit_achievement_evaluations WHERE workspace_id=?",
      )
      .get(workspace.id) as Row | undefined;
    const pref = this.db
      .prepare(
        "SELECT * FROM adit_achievement_preferences WHERE workspace_id=?",
      )
      .get(workspace.id) as Row | undefined;
    const progress = this.db
      .prepare("SELECT * FROM adit_achievement_progress WHERE workspace_id=?")
      .all(workspace.id) as Row[];
    const unlocks = this.db
      .prepare(
        "SELECT * FROM adit_achievement_unlocks WHERE workspace_id=? AND valid=1 ORDER BY tier",
      )
      .all(workspace.id) as Row[];
    // Normalize old multi-selection and select the first unlocked item once.
    // Persist the normalization, so all tabs and export consumers agree.
    if (e?.status === "ready") this.db.transaction(() => {
      const saved = this.db.prepare("SELECT achievement_key FROM adit_achievement_export_items WHERE workspace_id=? AND selected=1").all(workspace.id) as {achievement_key:string}[];
      const available = achievementRules.filter(r => progress.some(p => p.achievement_key === r.key && p.highest_tier > 0));
      const chosen = available.find(r => saved.some(s => s.achievement_key === r.key)) || available[0];
      if (saved.length === (chosen ? 1 : 0) && (!chosen || saved[0].achievement_key === chosen.key)) return;
      this.db.prepare("UPDATE adit_achievement_export_items SET selected=0 WHERE workspace_id=? AND selected<>0").run(workspace.id);
      if (chosen) this.db.prepare(`INSERT INTO adit_achievement_export_items VALUES (?,?,1,'plain',1,1,0,0)
        ON CONFLICT(workspace_id,achievement_key) DO UPDATE SET selected=1`).run(workspace.id, chosen.key);
    })();
    const options = this.db
      .prepare(
        "SELECT * FROM adit_achievement_export_items WHERE workspace_id=?",
      )
      .all(workspace.id) as Row[];
    const evidence = this.db
      .prepare(
        `SELECT e.*,t.prompt_message_id,(SELECT count(*) FROM adit_history_messages m WHERE m.turn_id=e.turn_id) AS messages,
      (SELECT group_concat(b.text_content,' ') FROM adit_history_blocks b WHERE b.message_id=t.prompt_message_id) AS prompt
      FROM adit_achievement_evidence e LEFT JOIN adit_history_turns t ON t.id=e.turn_id WHERE e.workspace_id=? AND e.tier=0 ORDER BY e.ordinal`,
      )
      .all(workspace.id) as Row[];
    const notify = pref?.notify_enabled !== 0;
    const stale =
      e &&
      e.scope_revision !==
        digest([
          workspace.path,
          [...workspace.providers].sort(),
          [...workspace.repositories].sort(),
          e.timezone,
        ]);
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      repositories: workspace.repositories.length,
      timezone:
        pref?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      status:
        stale && e.status !== "failed" ? "pending" : e?.status || "pending",
      evaluatedAt: e?.finished_at ?? null,
      firstAt: e?.first_at ?? null,
      sourceErrors: e?.source_errors || 0,
      error: e?.error || null,
      revision: e?.id || null,
      notify,
      unread: notify
        ? unlocks.filter((u) => u.acknowledged_at === null).length
        : 0,
      backfillCount: e?.backfill_count || 0,
      items: achievementRules.map((r) => {
        const p = progress.find((p) => p.achievement_key === r.key),
          o = options.find((o) => o.achievement_key === r.key);
        return {
          key: r.key,
          value: p?.best_value ?? null,
          current: p?.current_value ?? null,
          bestAt: p?.best_at ?? null,
          tier: p?.highest_tier || 0,
          incomplete: p?.incomplete || 0,
          options: o
            ? {
                selected: !!o.selected,
                style: o.style,
                showValue: !!o.show_value,
                showDate: !!o.show_date,
                showAgent: !!o.show_agent,
                showPrompt: !!o.show_prompt,
              }
            : { ...defaultOptions },
          unlocks: unlocks
            .filter((u) => u.achievement_key === r.key)
            .map((u) => ({
              id: u.id,
              tier: u.tier,
              at: u.achieved_at,
              discoveredAt: u.discovered_at,
              unread: notify && u.acknowledged_at === null,
            })),
          evidence: evidence
            .filter((v) => v.achievement_key === r.key)
            .map((v) => ({
              provider: v.provider,
              sessionId: v.session_id,
              turnId: v.turn_id,
              toolId: v.tool_call_id,
              repository: v.repository,
              sha: v.commit_sha,
              at: v.started_at,
              endAt: v.ended_at,
              value: v.value,
              timeSource: v.time_source,
              prompt: v.prompt
                ? redactOverview(promptSummary(v.provider, v.prompt) || "") ||
                  null
                : null,
              messages: v.messages || null,
            })),
        };
      }),
    };
  }
  acknowledge(workspace: LocalWorkspace, ids: unknown) {
    if (
      !Array.isArray(ids) ||
      ids.length > 24 ||
      ids.some((id) => typeof id !== "string")
    )
      throw new LocalStateError("Invalid achievement IDs");
    const update = this.db.prepare(
      "UPDATE adit_achievement_unlocks SET notified_at=coalesce(notified_at,?),acknowledged_at=coalesce(acknowledged_at,?) WHERE workspace_id=? AND id=? AND valid=1",
    );
    this.db.transaction(() => {
      for (const id of ids)
        update.run(Date.now(), Date.now(), workspace.id, id);
    })();
  }
  savePreferences(workspace: LocalWorkspace, input: Record<string, unknown>) {
    if (input.notify !== undefined && typeof input.notify !== "boolean")
      throw new LocalStateError("Invalid notification preference");
    const key = input.key;
    if (key !== undefined && !achievementRules.some((r) => r.key === key))
      throw new LocalStateError("Unknown achievement");
    const fields = [
      "selected",
      "showValue",
      "showDate",
      "showAgent",
      "showPrompt",
    ];
    for (const field of fields)
      if (input[field] !== undefined && typeof input[field] !== "boolean")
        throw new LocalStateError("Invalid export preference");
    if (
      input.style !== undefined &&
      !["plain", "rich"].includes(String(input.style))
    )
      throw new LocalStateError("Invalid badge style");
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO adit_achievement_preferences VALUES (?,1,?)",
        )
        .run(workspace.id, Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (input.notify !== undefined) {
        this.db
          .prepare(
            "UPDATE adit_achievement_preferences SET notify_enabled=? WHERE workspace_id=?",
          )
          .run(Number(input.notify), workspace.id);
        if (!input.notify)
          this.db
            .prepare(
              "UPDATE adit_achievement_unlocks SET acknowledged_at=coalesce(acknowledged_at,?) WHERE workspace_id=?",
            )
            .run(Date.now(), workspace.id);
      }
      if (key !== undefined) {
        const data = this.read(workspace),
          item = data.items.find((i) => i.key === key)!;
        if (input.selected === true && (!item.tier || data.status !== "ready"))
          throw new LocalStateError(
            "Only unlocked achievements can be exported",
            409,
          );
        const o = {
          ...item.options,
          ...Object.fromEntries(
            [...fields, "style"]
              .filter((f) => input[f] !== undefined)
              .map((f) => [f, input[f]]),
          ),
        };
        if (o.selected) this.db.prepare("UPDATE adit_achievement_export_items SET selected=0 WHERE workspace_id=? AND achievement_key<>?").run(workspace.id, key);
        this.db
          .prepare(
            "INSERT OR REPLACE INTO adit_achievement_export_items VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            workspace.id,
            key,
            Number(o.selected),
            o.style,
            Number(o.showValue),
            Number(o.showDate),
            Number(o.showAgent),
            Number(o.showPrompt),
          );
      }
    })();
    return this.read(workspace);
  }
}
