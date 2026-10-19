import type Database from "better-sqlite3";
import type { LocalWorkspace } from "../local-state.js";
import { LocalStateError } from "../local-state.js";
import { insideDirectory, sourceDefinitions } from "./sources.js";
import { LocalPrices, type CostUsage } from "./pricing.js";
import { NON_MERGE_COMMIT_SQL } from "./commit-policy.js";

type Row = Record<string, any>;
export function redactOverview(text: string): string {
  return text
    .replace(
      /(?:-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----|sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{16,}|github_pat_[a-zA-Z0-9_]+|AKIA[A-Z0-9]{16}|AIza[\w-]{20,}|xox[baprs]-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|Bearer\s+\S+|(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?[^\s"']+)/gi,
      "[已隐藏]",
    )
    .slice(0, 240);
}
function dateKey(at: number, zone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
function shift(day: string, days: number) {
  return new Date(Date.parse(day + "T12:00:00Z") + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
export class LocalAnalytics {
  readonly prices: LocalPrices;
  private cache = new Map<
    string,
    {
      changes: number;
      dataVersion: number;
      result: ReturnType<LocalAnalytics["calculate"]>;
    }
  >();
  constructor(private db: Database.Database) {
    this.prices = new LocalPrices(db);
    db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS overview_scope(provider TEXT,id TEXT,PRIMARY KEY(provider,id))",
    );
    db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS overview_all(provider TEXT,id TEXT,PRIMARY KEY(provider,id))",
    );
  }
  overview(
    workspace: LocalWorkspace,
    options: {
      range?: string;
      provider?: string;
      year?: number;
      timezone?: string;
      now?: number;
    } = {},
  ) {
    this.prices.reload();
    const now = options.now ?? Date.now(),
      zone =
        options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    let today: string;
    try {
      today = dateKey(now, zone);
    } catch {
      throw new LocalStateError("Invalid timezone");
    }
    const cacheKey = JSON.stringify([
      workspace,
      options.range,
      options.provider,
      options.year,
      zone,
      today,
      this.prices.status(),
    ]);
    const changes = () =>
      Number(
        (this.db.prepare("SELECT total_changes() AS n").get() as { n: number })
          .n,
      );
    const dataVersion = Number(
      this.db.pragma("data_version", { simple: true }),
    );
    const cached = this.cache.get(cacheKey);
    if (
      cached &&
      cached.changes === changes() &&
      cached.dataVersion === dataVersion
    )
      return cached.result;
    const result = this.calculate(workspace, options);
    if (this.cache.size >= 32) this.cache.clear();
    this.cache.set(cacheKey, { changes: changes(), dataVersion, result });
    return result;
  }
  private calculate(
    workspace: LocalWorkspace,
    options: {
      range?: string;
      provider?: string;
      year?: number;
      timezone?: string;
      now?: number;
    },
  ) {
    const range = options.range || "all",
      provider = options.provider || "all",
      zone =
        options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      now = options.now ?? Date.now();
    if (!["all", "7d", "30d"].includes(range))
      throw new LocalStateError("Invalid overview range");
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone }).format(now);
    } catch {
      throw new LocalStateError("Invalid timezone");
    }
    const today = dateKey(now, zone),
      year = options.year ?? Number(today.slice(0, 4));
    if (!Number.isInteger(year) || year < 1970 || year > 9998)
      throw new LocalStateError("Invalid year");
    const from =
        range === "all"
          ? "0000-01-01"
          : shift(today, range === "7d" ? -6 : -29),
      to = shift(today, 1);
    const dayFormat = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const hourFormat = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      hourCycle: "h23",
    });
    const day = (at: number) => dayFormat.format(at),
      inRange = (at: number | null) =>
        at !== null && day(at) >= from && day(at) < to;
    this.db.function("ov_day", { deterministic: true }, (at: number | null) =>
      at === null ? null : day(at),
    );
    this.db.function("ov_hour", { deterministic: true }, (at: number | null) =>
      at === null ? null : Number(hourFormat.format(at)),
    );
    const run = () => {
      const sessions = (
        this.db
          .prepare(
            `SELECT s.provider,s.id,s.parent_id,s.relationship,s.started_at,s.last_activity_at,s.transcript_revision,coalesce(nullif(s.cwd,''),a.workspace,'') AS cwd FROM adit_history_sessions s LEFT JOIN adit_history_assignments a ON a.provider=s.provider AND a.session_id=s.id`,
          )
          .all() as Row[]
      ).filter(
        (s) =>
          (workspace.providers.includes(s.provider) ||
            ["claude-ai", "chatgpt", "gemini-apps"].includes(s.provider)) &&
          s.cwd &&
          insideDirectory(workspace.path, s.cwd),
      );
      const agents = [
        ...new Set(sessions.map((s) => s.provider as string)),
      ].map((id) => ({
        id,
        name: sourceDefinitions().find((p) => p.id === id)?.name || id,
      }));
      if (provider !== "all" && !agents.some((a) => a.id === provider))
        throw new LocalStateError("Agent has no records in this workspace");
      const selected = sessions.filter(
          (s) => provider === "all" || s.provider === provider,
        ),
        main = selected.filter(
          (s) => !s.parent_id || s.relationship === "fork",
        );
      this.db.prepare("DELETE FROM overview_scope").run();
      const add = this.db.prepare("INSERT INTO overview_scope VALUES(?,?)");
      for (const s of main) add.run(s.provider, s.id);
      this.db.prepare("DELETE FROM overview_all").run();
      const addAll = this.db.prepare("INSERT INTO overview_all VALUES(?,?)");
      for (const s of sessions.filter(
        (s) => !s.parent_id || s.relationship === "fork",
      ))
        addAll.run(s.provider, s.id);
      const join =
        "JOIN overview_scope q ON q.provider=m.provider AND q.id=m.session_id";
      const messageFrom =
        "overview_scope q CROSS JOIN adit_history_messages m ON q.provider=m.provider AND q.id=m.session_id";
      const rows = (sql: string, ...args: any[]) =>
        this.db.prepare(sql).all(...args) as Row[];
      const activity = rows(
        `SELECT ov_day(m.occurred_at) AS date,ov_hour(m.occurred_at) AS hour,count(*) AS count FROM ${messageFrom} WHERE m.occurred_at IS NOT NULL AND ov_day(m.occurred_at)>=? AND ov_day(m.occurred_at)<? GROUP BY date,hour`,
        from,
        to,
      );
      const daily = new Map<string, number>(),
        hours = Array.from({ length: 24 }, (_, hour) => ({
          hour,
          total: 0,
          average: 0,
        }));
      for (const a of activity) {
        daily.set(a.date, (daily.get(a.date) || 0) + a.count);
        hours[a.hour].total += a.count;
      }
      const bounds = rows(
        `SELECT min(m.occurred_at) AS first,max(m.occurred_at) AS last,sum(m.occurred_at IS NULL) AS missing FROM ${messageFrom}`,
      )[0];
      const first = bounds.first === null ? null : day(bounds.first),
        last = bounds.last === null ? null : day(bounds.last);
      const coverageStart = first ? (first > from ? first : from) : null,
        coverageEnd = last ? (last < today ? last : today) : null;
      const recordDays =
        coverageStart && coverageEnd && coverageStart <= coverageEnd
          ? Math.round(
              (Date.parse(coverageEnd) - Date.parse(coverageStart)) /
                86_400_000,
            ) + 1
          : 0;
      for (const h of hours) h.average = recordDays ? h.total / recordDays : 0;
      const prompts = rows(
        `SELECT ov_day(m.started_at) AS date,count(*) AS count FROM adit_history_turns m ${join} WHERE m.started_at IS NOT NULL AND ov_day(m.started_at)>=? AND ov_day(m.started_at)<? GROUP BY date`,
        from,
        to,
      );
      const activeDays = prompts.length,
        promptCount =
          range === "all"
            ? rows(`SELECT count(*) AS n FROM adit_history_turns m ${join}`)[0]
                .n
            : prompts.reduce((n, p) => n + p.count, 0);
      const sessionCount =
        range === "all"
          ? main.length
          : rows(
              `SELECT count(*) AS n FROM (SELECT m.provider,m.session_id FROM ${messageFrom} WHERE ov_day(m.occurred_at)>=? AND ov_day(m.occurred_at)<? GROUP BY m.provider,m.session_id)`,
              from,
              to,
            )[0].n;
      const intervals = rows(
        `SELECT i.*,m.provider,m.session_id FROM adit_history_work_intervals i JOIN adit_history_turns m ON m.id=i.turn_id ${join}`,
      );
      const workBy = new Map<string, number>(),
        turnDurations = new Map<string, number>(),
        events: { at: number; delta: number; id: string }[] = [];
      // Count the first five minutes of a long idle gap as the evidenced effective interval; versioned rule.
      for (const i of intervals) {
        let start = i.started_at,
          end = i.started_at + i.counted_duration_ms;
        if (end <= start) continue;
        // Split at local day boundaries without assuming every local day is 24h.
        while (start < end) {
          let next = Math.min(
            end,
            (Math.floor(start / 3_600_000) + 1) * 3_600_000,
          );
          if (next <= start) break;
          if (day(start) !== day(next - 1)) {
            let low = start + 1,
              high = next;
            const current = day(start);
            while (low < high) {
              const mid = Math.floor((low + high) / 2);
              if (day(mid) === current) low = mid + 1;
              else high = mid;
            }
            next = low;
          }
          if (inRange(start)) {
            const amount = next - start;
            workBy.set(i.provider, (workBy.get(i.provider) || 0) + amount);
            turnDurations.set(
              i.turn_id,
              (turnDurations.get(i.turn_id) || 0) + amount,
            );
            events.push(
              { at: start, delta: 1, id: i.provider + ":" + i.session_id },
              { at: next, delta: -1, id: i.provider + ":" + i.session_id },
            );
          }
          start = next;
        }
      }
      let peak = 0,
        peakAt: number | null = null;
      const live = new Map<string, number>();
      for (const e of events.sort((a, b) => a.at - b.at || a.delta - b.delta)) {
        const n = (live.get(e.id) || 0) + e.delta;
        if (n) live.set(e.id, n);
        else live.delete(e.id);
        if (live.size > peak) {
          peak = live.size;
          peakAt = e.at;
        }
      }
      const topTurns = [...turnDurations]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([id, duration]) => {
          const t = this.db
            .prepare(
              `SELECT t.provider,t.session_id,t.started_at,t.duration_status,(SELECT group_concat(text_content,' ') FROM adit_history_blocks WHERE message_id=t.prompt_message_id) AS prompt,(SELECT count(*) FROM adit_history_messages WHERE turn_id=t.id) AS messages FROM adit_history_turns t WHERE t.id=?`,
            )
            .get(id) as Row;
          return {
            id,
            provider: String(t.provider),
            session_id: String(t.session_id),
            started_at: t.started_at as number | null,
            duration_status: String(t.duration_status),
            messages: Number(t.messages),
            prompt: redactOverview(t.prompt || ""),
            duration,
          };
        });
      const usage = rows(
        `SELECT m.* FROM adit_history_usage_entries m ${join} WHERE m.ledger_role='canonical' AND (?='all' OR (ov_day(m.occurred_at)>=? AND ov_day(m.occurred_at)<?))`,
        range,
        from,
        to,
      );
      const totals: Record<string, number | null> = {
        uncached_input_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      };
      const costDaily = new Map<string, Record<string, number>>(),
        models = new Map<
          string,
          { model: string; amount: number; requests: number }
        >(),
        sessionCosts = new Map<string, number>();
      let amount = 0,
        priced = 0,
        unpriced = 0,
        unknownCostTime = 0;
      for (const u of usage) {
        for (const key of Object.keys(totals)) {
          const value =
            key === "cache_write_tokens" &&
            u.provider === "codex" &&
            u[key] === null
              ? 0
              : u[key];
          if (value === null) totals[key] = null;
          else if (totals[key] !== null) totals[key]! += value;
        }
        const cost = this.prices.estimate(u as CostUsage);
        if (cost === null) {
          unpriced++;
          continue;
        }
        priced++;
        amount += cost;
        const key = u.provider + ":" + u.session_id;
        sessionCosts.set(key, (sessionCosts.get(key) || 0) + cost);
        const model = models.get(u.model) || {
          model: u.model,
          amount: 0,
          requests: 0,
        };
        model.amount += cost;
        model.requests++;
        models.set(u.model, model);
        if (u.occurred_at !== null) {
          const d = day(u.occurred_at),
            entry = costDaily.get(d) || {};
          entry[u.provider] = (entry[u.provider] || 0) + cost;
          costDaily.set(d, entry);
        } else unknownCostTime++;
      }
      if (!usage.length)
        for (const key of Object.keys(totals)) totals[key] = null;
      const commits = workspace.repositories.length
        ? rows(
            `SELECT c.sha,c.repository,c.authored_at FROM adit_local_commits c WHERE c.repository IN (${workspace.repositories.map(() => "?").join(",")}) AND ${NON_MERGE_COMMIT_SQL}`,
            ...workspace.repositories,
          ).filter((c) => range === "all" || inRange(c.authored_at))
        : [];
      const uniqueCommits = new Map<string, Row>();
      for (const c of commits) uniqueCommits.set(c.sha, c);
      // Submission associations are produced once after collection and read from saved analysis.
      const savedRun = this.db
        .prepare(
          "SELECT id FROM adit_attribution_runs WHERE workspace_id=? AND status='done' ORDER BY started_at DESC LIMIT 1",
        )
        .get(workspace.id) as Row | undefined;
      const links = new Map<string, Set<string>>();
      if (savedRun) {
        const saved = rows(
          "SELECT repository,sha,submit_provider,submit_session_id FROM adit_attribution_commits WHERE run_id=? AND submit_session_id IS NOT NULL",
          savedRun.id,
        );
        for (const association of saved) {
          if (
            !commits.some(
              (c) =>
                c.repository === association.repository &&
                c.sha === association.sha,
            )
          )
            continue;
          const set = links.get(association.sha) || new Set<string>();
          set.add(
            association.submit_provider + ":" + association.submit_session_id,
          );
          links.set(association.sha, set);
        }
      }
      const selectedKeys = new Set(main.map((s) => s.provider + ":" + s.id));
      const definite = [...links].filter(
          ([, s]) => s.size === 1 && selectedKeys.has([...s][0]),
        ),
        linkedSessions = new Set(definite.map(([, s]) => [...s][0]));
      const sample = [...sessionCosts]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 100),
        sampleKeys = new Set(sample.map(([k]) => k)),
        sampleCost = sample.reduce((n, [, v]) => n + v, 0),
        withCost = sample
          .filter(([k]) => linkedSessions.has(k))
          .reduce((n, [, v]) => n + v, 0),
        sampleCommits = definite.filter(([, s]) =>
          sampleKeys.has([...s][0]),
        ).length;
      const busiest = [...daily].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0];
      const yearDays = [];
      for (let d = `${year}-01-01`; d <= `${year}-12-31`; d = shift(d, 1))
        yearDays.push({
          date: d,
          count: daily.get(d) || 0,
          state:
            d < from || d >= to
              ? "outside"
              : daily.has(d)
                ? "recorded"
                : "unknown",
        });
      return {
        scope: {
          workspaceId: workspace.id,
          range,
          provider,
          year,
          timezone: zone,
          from,
          to,
          first,
          algorithmVersion: 1,
          inputRevision: sessions.reduce(
            (n, s) => n + s.transcript_revision,
            0,
          ),
        },
        agents,
        summary: {
          sessions: sessionCount,
          subtasks: selected.filter(
            (s) =>
              s.parent_id &&
              s.relationship !== "fork" &&
              (range === "all" ||
                inRange(s.started_at) ||
                inRange(s.last_activity_at)),
          ).length,
          messages:
            [...daily.values()].reduce((a, b) => a + b, 0) +
            (range === "all" ? bounds.missing || 0 : 0),
          prompts: promptCount,
          activeDays,
          recordDays,
          totalCommits: uniqueCommits.size,
          linkedCommits: definite.length,
          estimatedCost: priced ? amount : null,
          avgCommitCost: sampleCommits
            ? Math.round(withCost / sampleCommits)
            : null,
          withCommitRatio: sampleCost ? withCost / sampleCost : null,
          topModel:
            [...models.values()].sort((a, b) => b.amount - a.amount)[0]
              ?.model || null,
        },
        activity: {
          days: yearDays,
          hours,
          peakHours: hours
            .filter((h) => h.total > 0)
            .sort((a, b) => b.total - a.total || a.hour - b.hour)
            .slice(0, 2)
            .map((h) => h.hour),
          busiest: busiest ? { date: busiest[0], count: busiest[1] } : null,
          years: [
            ...new Set([
              year,
              ...sessions.flatMap((s) =>
                [s.started_at, s.last_activity_at]
                  .filter((v) => v !== null)
                  .map((v) => Number(day(v).slice(0, 4))),
              ),
            ]),
          ].sort((a, b) => b - a),
        },
        work: {
          duration: [...workBy.values()].reduce((a, b) => a + b, 0),
          byProvider: [...workBy].map(([provider, duration]) => ({
            provider,
            duration,
          })),
          over30m: [...turnDurations.values()].filter((v) => v > 1_800_000)
            .length,
          peak,
          peakAt,
          longest: topTurns,
        },
        usage: { totals, entries: usage.length, priced, unpriced },
        costs: {
          amount: priced ? amount : null,
          daily: [...costDaily]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, providers]) => ({ date, providers })),
          models: [...models.values()].sort((a, b) => b.amount - a.amount),
          prices: this.prices.status(),
        },
        averageCommitCost: {
          sampleSize: sample.length,
          coverage: amount ? sampleCost / amount : null,
        },
        coverage: {
          missingTimestamp: bounds.missing || 0,
          unknownCostTime,
          unpriced,
          childUsageExcluded: selected.length - main.length,
          attribution: "partial" as const,
          recordDays: "observed_span" as const,
          missingUsage: rows(
            `SELECT count(*) AS n FROM ${messageFrom} WHERE m.role='assistant' AND NOT EXISTS(SELECT 1 FROM adit_history_usage_observations o WHERE o.message_id=m.id) AND (?='all' OR (ov_day(m.occurred_at)>=? AND ov_day(m.occurred_at)<?))`,
            range,
            from,
            to,
          )[0].n,
        },
      };
    };
    return this.db.transaction(run)();
  }
}
export type OverviewData = ReturnType<LocalAnalytics["overview"]>;
