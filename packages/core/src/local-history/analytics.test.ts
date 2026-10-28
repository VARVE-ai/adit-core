import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { LocalStore } from "../local-state.js";
import { createHistorySchema } from "./schema.js";
import { StructuredHistory } from "./structured-store.js";
import { LocalAnalytics, redactOverview } from "./analytics.js";
import { parsePrices, LocalPrices } from "./pricing.js";
import type { HistorySession } from "./types.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const catalog = {
  "model-a": {
    mode: "chat",
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000008,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost: 0.0000025,
    aliases: ["alias-a"],
  },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adit-overview-")),
    store = new LocalStore(join(root, "state"));
  createHistorySchema(store.db);
  const history = new StructuredHistory(store.db),
    analytics = new LocalAnalytics(store.db),
    workspace = store.saveWorkspace({
      path: root,
      providers: ["claude", "codex"],
      repositories: [root],
    });
  analytics.prices.install(catalog);
  cleanup.push(async () => {
    await analytics.prices.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, history, analytics, workspace };
}
function session(root: string, id = "s"): HistorySession {
  return {
    provider: "claude",
    id,
    cwd: root,
    messages: [
      {
        key: "u",
        role: "user",
        timestamp: "2026-10-18T23:59:00Z",
        content: "implement feature",
        raw: {},
      },
      {
        key: "a",
        role: "assistant",
        timestamp: "2026-10-19T00:09:00Z",
        content: "done",
        model: "model-a",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
          output_tokens: 50,
        },
        raw: {},
      },
    ],
  };
}
const scope = {
  timezone: "UTC",
  now: Date.parse("2026-10-19T12:00:00Z"),
  year: 2026,
};
it("shows the latest twelve calendar months and scopes the heatmap footer without changing overview totals", () => {
  const { root, history, analytics, workspace } = fixture();
  const dates = ["2025-10-31", "2025-11-01", "2026-10-18"];
  for (const date of dates) {
    const record = session(root, date);
    record.messages.forEach((m, i) => { m.timestamp = `${date}T12:0${i}:00Z`; });
    history.write(record);
  }
  const result = analytics.overview(workspace, { ...scope, activityRange: "12m" });
  expect(result.activity.days[0].date).toBe("2025-11-01");
  expect(result.activity.days.at(-1)?.date).toBe("2026-10-19");
  expect(result.activity.days.filter((d) => d.count > 0).map((d) => d.date)).toEqual(dates.slice(1));
  expect(result.activity.period).toEqual({ activeDays: 2, recordDays: 352, busiest: { date: "2025-11-01", count: 2 } });
  const previousYear = analytics.overview(workspace, { ...scope, year: 2025 });
  expect(previousYear.activity.days[0].date).toBe("2025-01-01");
  expect(previousYear.activity.days.at(-1)?.date).toBe("2025-12-31");
  expect(previousYear.summary).toEqual(result.summary);
  expect(previousYear.activity.period).toEqual({ activeDays: 2, recordDays: 62, busiest: { date: "2025-10-31", count: 2 } });
  expect(analytics.overview(workspace, { ...scope, activityRange: "12m" })).toBe(result);
  const week = analytics.overview(workspace, { ...scope, activityRange: "12m", range: "7d" });
  expect(week.activity.period).toEqual({ activeDays: 1, recordDays: 6, busiest: { date: "2026-10-18", count: 2 } });
  expect(week.activity.days[0].state).toBe("outside");
});
it("uses the local month boundary, includes leap day and keeps empty activity empty", () => {
  const { analytics, workspace } = fixture();
  const options = { activityRange: "12m", now: Date.parse("2024-02-29T16:00:00Z") };
  const utc = analytics.overview(workspace, { ...options, timezone: "UTC" });
  expect(utc.activity.days[0].date).toBe("2023-03-01");
  expect(utc.activity.days.at(-1)?.date).toBe("2024-02-29");
  expect(utc.activity.days).toHaveLength(366);
  const local = analytics.overview(workspace, { ...options, timezone: "Asia/Shanghai" });
  expect(local.activity.days[0].date).toBe("2023-04-01");
  expect(local.activity.days.at(-1)?.date).toBe("2024-03-01");
  expect(local.activity.period).toEqual({ activeDays: 0, recordDays: 0, busiest: null });
  expect(() => analytics.overview(workspace, { activityRange: "invalid" })).toThrow("Invalid activity range");
});
it("counts a continued native conversation once and includes usage/messages from both segments",()=>{
 const {root,history,analytics,workspace}=fixture();history.write(session(root));
 const first=analytics.overview(workspace,scope);
 history.write({...session(root,"s_page"),parentId:"s",relationship:"continuation"});
 const combined=analytics.overview(workspace,scope);
 expect(combined.summary.sessions).toBe(1);expect(combined.summary.subtasks).toBe(0);
 expect(combined.summary.messages).toBe(first.summary.messages*2);
 expect(combined.summary.prompts).toBe(first.summary.prompts*2);
 expect(combined.summary.estimatedCost).toBe(first.summary.estimatedCost!*2);
});
it("aggregates structured facts, excludes child tasks, respects directory boundaries and repeated replacements", () => {
  const { root, history, analytics, workspace } = fixture();
  const s = session(root);
  history.write(s);
  history.write(s);
  history.write({
    ...session(root, "child"),
    parentId: "s",
    relationship: "subagent",
  });
  history.write(session(root + "-other", "outside"));
  const result = analytics.overview(workspace, scope);
  expect(result.summary).toMatchObject({
    sessions: 1,
    subtasks: 1,
    messages: 2,
    prompts: 1,
    activeDays: 1,
    recordDays: 2,
    estimatedCost: 635,
  });
  expect(result.usage.totals).toMatchObject({
    uncached_input_tokens: 100,
    cache_read_tokens: 20,
    cache_write_tokens: 10,
    output_tokens: 50,
    total_tokens: 180,
  });
  expect(result.work.duration).toBe(300_000);
  expect(result.work.longest[0]).toMatchObject({
    duration: 300_000,
    prompt: "implement feature",
    messages: 2,
  });
  expect(result.activity.hours[0].average).toBe(0.5);
  expect(result.activity.days).toHaveLength(365);
  expect(result.coverage.childUsageExcluded).toBe(1);
});
it("keeps zero distinct from missing usage and rejects invalid scope instead of broadening it", () => {
  const { root, history, analytics, workspace } = fixture();
  history.write({
    provider: "codex",
    id: "s",
    cwd: root,
    messages: [
      {
        key: "a",
        role: "assistant",
        timestamp: "2026-10-19T01:00:00Z",
        model: "model-a",
        content: "",
        usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
        raw: {},
      },
    ],
  });
  expect(analytics.overview(workspace, scope).summary.estimatedCost).toBe(0);
  history.write({
    provider: "codex",
    id: "s",
    cwd: root,
    messages: [
      {
        key: "a",
        role: "assistant",
        timestamp: "2026-10-19T01:00:00Z",
        model: "unknown",
        content: "",
        usage: { output_tokens: 0 },
        raw: {},
      },
    ],
  });
  const result = analytics.overview(workspace, scope);
  expect(result.summary.estimatedCost).toBeNull();
  expect(result.usage.totals.uncached_input_tokens).toBeNull();
  expect(result.usage.unpriced).toBe(1);
  expect(() =>
    analytics.overview(workspace, { ...scope, range: "oops" }),
  ).toThrow();
  expect(() =>
    analytics.overview(workspace, { ...scope, provider: "other" }),
  ).toThrow();
  expect(() =>
    analytics.overview(workspace, { ...scope, timezone: "invalid" }),
  ).toThrow();
});

it("counts profile activity and model shares by original prompts, not replies, tokens or child tasks", () => {
  const { root, history, analytics, workspace } = fixture();
  const first = session(root);
  first.messages.push({
    ...first.messages[1],
    key: "another-reply",
    model: "expensive-model",
    timestamp: "2026-10-19T00:10:00Z",
  });
  history.write(first);
  history.write({
    ...session(root, "child"),
    parentId: "s",
    relationship: "subagent",
  });
  history.write({
    ...session(root, "codex"),
    provider: "codex",
    messages: [
      {
        key: "u",
        role: "user",
        timestamp: "2026-10-19T05:00:00Z",
        content: "second prompt",
        raw: {},
      },
      {
        key: "a",
        role: "assistant",
        timestamp: "2026-10-19T05:01:00Z",
        content: "reply without model",
        raw: {},
      },
    ],
  });
  const data = analytics.overview(workspace, scope);
  expect(data.summary.prompts).toBe(2);
  expect(data.profile.days).toEqual([
    { date: "2026-10-18", count: 1 },
    { date: "2026-10-19", count: 1 },
  ]);
  expect(data.profile.agents.map((a) => [a.id, a.count])).toEqual([
    ["claude", 1],
    ["codex", 1],
  ]);
  expect(data.profile.models).toEqual([{ model: "model-a", count: 1 }]);
  expect(data.profile.unknownModelPrompts).toBe(1);
  expect(data.profile.submissionAnalyzed).toBe(false);
  const later = analytics.overview(workspace, {
    ...scope,
    range: "30d",
    now: Date.parse("2026-11-18T12:00:00Z"),
  });
  expect(later.summary.prompts).toBe(0);
  expect(later.profile.models).toEqual([]);
  expect(later.profile.days).toEqual([]);
});
it("clips work at the local midnight including a half-hour timezone and does not extend missing timestamps", () => {
  const { root, history, analytics, workspace } = fixture();
  history.write({
    provider: "claude",
    id: "s",
    cwd: root,
    messages: [
      {
        key: "u",
        role: "user",
        timestamp: "2026-10-12T18:29:00Z",
        content: "work",
        raw: {},
      },
      {
        key: "a",
        role: "assistant",
        timestamp: "2026-10-12T18:34:00Z",
        content: "done",
        raw: {},
      },
    ],
  });
  const result = analytics.overview(workspace, {
    range: "7d",
    timezone: "Asia/Kolkata",
    year: 2026,
    now: Date.parse("2026-10-19T01:00:00Z"),
  });
  expect(result.work.duration).toBe(240_000);
  expect(result.summary.prompts).toBe(0);
  expect(result.summary.sessions).toBe(1);
  history.write({
    provider: "claude",
    id: "s",
    cwd: root,
    messages: [{ key: "u", role: "user", content: "unknown time", raw: {} }],
  });
  const unknown = analytics.overview(workspace, scope);
  expect(unknown.work.duration).toBe(0);
  expect(unknown.coverage.missingTimestamp).toBe(1);
  expect(unknown.summary.prompts).toBe(1);
});
it("links only evidenced commits, deduplicates cross-repository SHAs, and keeps the Git denominator under Agent filtering", () => {
  const { root, store, history, analytics, workspace } = fixture(),
    sha = "a".repeat(40);
  const s = session(root);
  s.messages.push(
    {
      key: "tool",
      role: "assistant",
      timestamp: "2026-10-19T00:10:00Z",
      content: [
        {
          type: "tool_use",
          id: "call",
          name: "Bash",
          input: { command: "git commit -m feature" },
        },
      ],
      raw: {},
    },
    {
      key: "result",
      role: "user",
      timestamp: "2026-10-19T00:10:01Z",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call",
          content: `[feature/test ${sha.slice(0, 7)}] feature`,
        },
      ],
      raw: {},
    },
  );
  history.write(s);
  history.write({ ...session(root, "other-agent"), provider: "codex" });
  const save = store.db.prepare(
    "INSERT INTO adit_local_commits VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const hash of [sha, "b".repeat(40), "c".repeat(40)])
    save.run(
      root,
      hash,
      "tree",
      Date.parse("2026-10-19T00:10:00Z"),
      "Me",
      "me@example.test",
      Date.now(),
      "Me",
      "me@example.test",
      "subject",
      "body",
      Date.now(),
    );
  for (const [ordinal, parent] of [sha, "b".repeat(40)].entries())
    store.db
      .prepare("INSERT INTO adit_local_commit_parents VALUES (?,?,?,?)")
      .run(root, "c".repeat(40), parent, ordinal);
  store.db
    .prepare(
      "INSERT INTO adit_attribution_runs (id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES (?,?,?,?,?,?)",
    )
    .run("saved", workspace.id, 2, "fixture", "done", Date.now());
  for (const hash of [sha, "c".repeat(40)])
    store.db
      .prepare(
        "INSERT INTO adit_attribution_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "saved",
        root,
        hash,
        "claude",
        "s",
        null,
        null,
        "hash",
        sha,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      );
  const result = analytics.overview(workspace, {
    ...scope,
    provider: "claude",
  });
  expect(result.summary.totalCommits).toBe(2);
  expect(result.summary.linkedCommits).toBe(1);
  expect(result.summary.avgCommitCost).toBe(635);
  const codex = analytics.overview(workspace, { ...scope, provider: "codex" });
  expect(codex.summary.totalCommits).toBe(2);
  expect(codex.summary.linkedCommits).toBe(0);
});
it("does not expose recognized secrets in overview prompts", () => {
  expect(
    redactOverview("api_key=private-value Bearer abc sk-abcdefghijklmnop"),
  ).not.toContain("private-value");
  expect(redactOverview("token=abcdefghijklmnop")).toBe("[已隐藏]");
});
it("does not count a long idle gap as concurrent work", () => {
  const { root, history, analytics, workspace } = fixture();
  const a = session(root, "a");
  a.messages[0].timestamp = "2026-10-19T12:00:00Z";
  a.messages[1].timestamp = "2026-10-19T12:10:00Z";
  history.write(a);
  const b = session(root, "b");
  b.messages[0].timestamp = "2026-10-19T12:07:00Z";
  b.messages[1].timestamp = "2026-10-19T12:08:00Z";
  history.write(b);
  expect(analytics.overview(workspace, scope).work).toMatchObject({
    duration: 360000,
    peak: 1,
  });
  b.messages[0].timestamp = "2026-10-19T12:02:00Z";
  b.messages[1].timestamp = "2026-10-19T12:03:00Z";
  history.write(b);
  expect(analytics.overview(workspace, scope).work.peak).toBe(2);
});
it("reuses unchanged projections and invalidates them after fact correction, deletion and price changes", () => {
  const { root, store, history, analytics, workspace } = fixture();
  history.write(session(root));
  const first = analytics.overview(workspace, scope);
  expect(analytics.overview(workspace, scope)).toBe(first);
  const changed = session(root);
  changed.messages[1].usage!.output_tokens = 100;
  history.write(changed);
  expect(analytics.overview(workspace, scope).summary.estimatedCost).toBe(1035);
  analytics.prices.install({
    "model-a": { ...catalog["model-a"], output_cost_per_token: 0 },
  });
  expect(analytics.overview(workspace, scope).summary.estimatedCost).toBe(1035);
  store.db.prepare("DELETE FROM adit_history_sessions").run();
  expect(analytics.overview(workspace, scope).summary.sessions).toBe(0);
});
it("keeps cached filters through unrelated writes while refreshing assignments, Git facts and saved associations", () => {
  const { root, store, history, analytics, workspace } = fixture();
  history.write(session(root));
  const first = analytics.overview(workspace, scope);
  const week = analytics.overview(workspace, { ...scope, range: "7d" });
  store.set("inspection-progress-test", { checked: 10 });
  history.write(session(root + "-other", "outside"));
  expect(analytics.overview(workspace, scope)).toBe(first);
  expect(analytics.overview(workspace, { ...scope, range: "7d" })).toBe(week);
  expect(
    analytics.overview({ ...workspace, version: workspace.version + 1 }, scope),
  ).toBe(first);

  history.write(session("", "imported"));
  expect(analytics.overview(workspace, scope)).toBe(first);
  store.db
    .prepare("INSERT INTO adit_history_assignments VALUES (?,?,?)")
    .run("claude", "imported", root);
  expect(analytics.overview(workspace, scope).summary.sessions).toBe(2);

  const sha = "d".repeat(40);
  store.db
    .prepare("INSERT INTO adit_local_commits VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      root,
      sha,
      "tree",
      Date.parse("2026-10-19T00:10:00Z"),
      "Me",
      "me@example.test",
      Date.now(),
      "Me",
      "me@example.test",
      "subject",
      "body",
      Date.now(),
    );
  const withCommit = analytics.overview(workspace, scope);
  expect(withCommit.summary.totalCommits).toBe(1);
  expect(withCommit.summary.linkedCommits).toBe(0);
  store.db
    .prepare(
      "INSERT INTO adit_attribution_runs (id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES (?,?,?,?,?,?)",
    )
    .run("saved-cache", workspace.id, 2, "fixture", "done", Date.now());
  store.db
    .prepare(
      "INSERT INTO adit_attribution_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "saved-cache",
      root,
      sha,
      "claude",
      "s",
      null,
      null,
      "hash",
      sha,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    );
  expect(analytics.overview(workspace, scope).summary.linkedCommits).toBe(1);
  store.db
    .prepare(
      "UPDATE adit_attribution_commits SET submit_session_id=NULL WHERE run_id=?",
    )
    .run("saved-cache");
  expect(analytics.overview(workspace, scope).summary.linkedCommits).toBe(0);
  store.db.prepare("DELETE FROM adit_local_commits").run();
  expect(analytics.overview(workspace, scope).summary.totalCommits).toBe(0);
});
it("reuses compiled prices without mixing threshold rates or retaining an outdated catalog", () => {
  const { analytics } = fixture();
  const prices = analytics.prices;
  prices.install({
    fixture: {
      mode: "chat",
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0,
      input_cost_per_token_above_200k_tokens: 0.000004,
      input_cost_per_token_above_100k_tokens: 0.000002,
      input_cost_per_token_above_300k_tokens: null,
    },
  });
  const usage = {
    provider: "claude",
    model: "fixture",
    scope: "message",
    input_total_tokens: 200001,
    uncached_input_tokens: 10,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
  };
  for (const [input, expected] of [
    [200001, 40],
    [100000, 10],
    [200000, 20],
    [300001, null],
    [100001, 20],
  ] as const)
    expect(prices.estimate({ ...usage, input_total_tokens: input })).toBe(
      expected,
    );
  prices.install({
    fixture: {
      mode: "chat",
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0,
    },
  });
  expect(prices.estimate(usage)).toBe(30);
});
it("uses Cloud-compatible exact model/unique alias, decimal pricing, per-request tiers and unknown rates", () => {
  const { analytics } = fixture(),
    p = analytics.prices;
  const usage = {
    provider: "claude",
    model: "alias-a",
    scope: "message",
    input_total_tokens: 130,
    uncached_input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 20,
    cache_write_tokens: 10,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
  };
  expect(p.estimate(usage)).toBe(635);
  expect(p.estimate({ ...usage, cache_read_tokens: null })).toBeNull();
  expect(p.estimate({ ...usage, model: "no-such-model" })).toBeNull();
  p.install({
    ...catalog,
    "model-b": { ...catalog["model-a"], aliases: ["alias-a"] },
  });
  expect(p.estimate(usage)).toBeNull();
  expect(p.estimate({ ...usage, model: "model-a" })).toBe(635);
  p.install({
    "model-a": {
      ...catalog["model-a"],
      input_cost_per_token_above_128k_tokens: 0.000004,
    },
  });
  expect(
    p.estimate({
      ...usage,
      model: "model-a",
      input_total_tokens: 128000,
      uncached_input_tokens: 128000,
    }),
  ).toBe(256435);
  expect(
    p.estimate({
      ...usage,
      model: "model-a",
      input_total_tokens: 128001,
      uncached_input_tokens: 128001,
    }),
  ).toBe(512439);
  expect(
    parsePrices({
      good: catalog["model-a"],
      bad: { ...catalog["model-a"], input_cost_per_token: null },
      free: { ...catalog["model-a"], input_cost_per_token: 0 },
    }),
  ).toHaveLength(2);
  p.install({
    "model-a": {
      ...catalog["model-a"],
      input_cost_per_token_above_128k_tokens: -1,
    },
  });
  expect(
    p.estimate({ ...usage, model: "model-a", input_total_tokens: 128001 }),
  ).toBeNull();
});
it("maps bare GLM names to stored official prices while preserving exact channel prices and offline use", async () => {
  const { analytics, store } = fixture(), p = analytics.prices;
  const official = {
    mode: "chat", litellm_provider: "zai", input_cost_per_token: 0.0000014,
    output_cost_per_token: 0.0000044, cache_read_input_token_cost: 0.00000026,
    cache_creation_input_token_cost: 0,
  };
  const reseller = {
    ...official, litellm_provider: "tencent", input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000004, cache_read_input_token_cost: 0,
    aliases: ["glm-5.3"],
  };
  const usage = {
    provider: "claude", model: "glm-5.3", scope: "message",
    input_total_tokens: 130, uncached_input_tokens: 100, output_tokens: 50,
    cache_read_tokens: 20, cache_write_tokens: 10,
    cache_write_5m_tokens: null, cache_write_1h_tokens: null,
  };
  // The fixture's previous snapshot predates the new catalog, as on a real refresh.
  store.db.prepare("UPDATE adit_model_price_snapshots SET fetched_at=0").run();
  p.install({ "tencent/glm-5.3": reseller, "zai/glm-5.3": official });
  expect(p.estimate(usage)).toBe(365);
  expect(p.estimate({ ...usage, model: " GLM-5.3 " })).toBe(365);
  expect(p.estimate({ ...usage, model: "zai/glm-5.3" })).toBe(365);
  expect(p.estimate({ ...usage, model: "tencent/glm-5.3" })).toBe(500);
  expect(p.estimate({ ...usage, model: "another/glm-5.3" })).toBeNull();
  const offline = new LocalPrices(store.db);
  expect(offline.estimate(usage)).toBe(365);
  await offline.close();
  // Refresh invalidates both the resolved model and its compiled rates.
  p.install({ "zai/glm-5.3": { ...official, input_cost_per_token: 0.0000024 } });
  expect(p.estimate(usage)).toBe(465);
  // Exact model IDs take precedence even when an official mapping also exists.
  p.install({ "glm-5.3": reseller, "zai/glm-5.3": official });
  expect(p.estimate(usage)).toBe(500);
  // An unavailable official model never silently falls back to a reseller or variant.
  p.install({ "tencent/glm-5.3": reseller, "zai/glm-5.3-flash": official });
  expect(p.estimate(usage)).toBeNull();
  p.install({ "zai/glm-5.3": { ...official, cache_read_input_token_cost: null } });
  expect(p.estimate(usage)).toBeNull();
});
it("includes mapped Claude usage beside Codex in daily stacks without rewriting the recorded model", () => {
  const { root, store, history, analytics, workspace } = fixture();
  const claude = session(root);
  claude.messages[1].model = "glm-5.3";
  history.write(claude);
  const codex = session(root, "codex");
  codex.provider = "codex";
  codex.messages[1].usage = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 };
  history.write(codex);
  expect(analytics.overview(workspace, scope).usage.unpriced).toBe(1);
  analytics.prices.install({
    ...catalog,
    "zai/glm-5.3": {
      mode: "chat", input_cost_per_token: 0.0000014,
      output_cost_per_token: 0.0000044, cache_read_input_token_cost: 0.00000026,
      cache_creation_input_token_cost: 0,
    },
  });
  const result = analytics.overview(workspace, scope);
  expect(result.usage).toMatchObject({ priced: 2, unpriced: 0 });
  expect(result.costs.daily).toEqual([{ date: "2026-10-19", providers: { claude: 365, codex: 570 } }]);
  expect(result.costs.models).toContainEqual({ model: "glm-5.3", amount: 365, requests: 1 });
  expect(store.db.prepare("SELECT model FROM adit_history_usage_entries WHERE provider='claude'").get()).toEqual({ model: "glm-5.3" });
});
it("retains a successful price snapshot on network failure and reloads it offline", async () => {
  const { store } = fixture(),
    p = new LocalPrices(store.db);
  const original = p.status();
  // Simulate a failed refresh on a fresh DB catalog without printing any user content.
  const db = fixture().store.db;
  db.exec(
    "DELETE FROM adit_model_price_aliases; DELETE FROM adit_model_price_rates; DELETE FROM adit_model_prices; DELETE FROM adit_model_price_snapshots",
  );
  const empty = new LocalPrices(db);
  await empty.refresh(async () => {
    throw new Error("offline");
  });
  expect(empty.status().version).toBeNull();
  expect(empty.status().error).toBeTruthy();
  expect(original.version).toBeTruthy();
  expect(new LocalPrices(store.db).status().version).toBe(original.version);
  await p.refresh(async () => {
    throw new Error("offline");
  }, true);
  expect(p.status()).toMatchObject({
    version: original.version,
    error: expect.any(String),
  });
  expect(
    store.db
      .prepare(
        "SELECT model_id,input_rate FROM adit_model_prices WHERE version=?",
      )
      .get(original.version),
  ).toMatchObject({ model_id: "model-a", input_rate: "0.000002" });
  await empty.close();
  await p.close();
});
