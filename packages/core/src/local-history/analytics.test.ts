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
  expect(analytics.overview(workspace, scope).summary.estimatedCost).toBe(235);
  store.db.prepare("DELETE FROM adit_history_sessions").run();
  expect(analytics.overview(workspace, scope).summary.sessions).toBe(0);
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
