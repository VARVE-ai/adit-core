import { afterEach, expect, it } from "vitest";
import { LocalAchievements } from "./achievements.js";
import { LocalStore } from "../local-state.js";
import { StructuredHistory } from "./structured-store.js";
import { createHistorySchema } from "./schema.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HistorySession } from "./types.js";
const resources: { root: string; store: LocalStore }[] = [];
afterEach(() => {
  for (const { root, store } of resources.splice(0)) {
    store.close();
    const absolute = resolve(root);
    if (
      !absolute.startsWith(resolve(tmpdir()) + "\\") &&
      !absolute.startsWith(resolve(tmpdir()) + "/")
    )
      throw new Error("Unexpected test path");
    rmSync(absolute, { recursive: true, force: true });
  }
});
const start = Date.parse("2026-09-01T00:00:00Z"),
  options = { now: Date.parse("2026-10-20T12:00:00Z"), timezone: "UTC" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adit-achievements-")),
    store = new LocalStore(join(root, "state"));
  resources.push({ root, store });
  createHistorySchema(store.db);
  const history = new StructuredHistory(store.db),
    achievements = new LocalAchievements(store.db);
  const workspace = store.saveWorkspace({
    path: root,
    providers: ["codex"],
    repositories: [root],
  });
  return { root, store, history, achievements, workspace };
}
function session(root: string, id = "main", n = 13): HistorySession {
  return {
    id,
    provider: "codex",
    cwd: root,
    messages: Array.from({ length: n }, (_, i) => ({
      key: String(i),
      role: i ? "assistant" : "user",
      timestamp: new Date(start + i * 300000).toISOString(),
      content: i ? "work" : "build it",
      raw: {},
    })),
  };
}
it("persists historical unlocks and preferences, skips unchanged inputs and excludes children", () => {
  const { root, store, history, achievements, workspace } = fixture();
  history.write(session(root));
  history.write({
    ...session(root, "child", 50),
    parentId: "main",
    relationship: "subagent",
  });
  expect(achievements.read(workspace).status).toBe("pending");
  achievements.evaluate(workspace, options);
  const data = achievements.read(workspace),
    marathon = data.items[0];
  expect(marathon).toMatchObject({
    tier: 1,
    value: 3600000,
    bestAt: start + 3600000,
  });
  expect(marathon.unlocks[0]).toMatchObject({
    at: start + 3600000,
    discoveredAt: options.now,
    unread: true,
  });
  achievements.savePreferences(workspace, { key: "marathon", selected: true });
  achievements.acknowledge(
    workspace,
    data.items.flatMap((i) => i.unlocks.map((u) => u.id)),
  );
  expect(achievements.evaluate(workspace, options)).toEqual({ cached: true });
  expect(new LocalAchievements(store.db).read(workspace).unread).toBe(0);
  achievements.savePreferences(workspace, { notify: false });
  history.write(session(root, "main", 37));
  achievements.evaluate(workspace, options);
  expect(achievements.read(workspace).items[0].tier).toBe(2);
  achievements.savePreferences(workspace, { notify: true });
  expect(achievements.read(workspace).unread).toBe(0);
  expect(achievements.read(workspace).items[0].options.selected).toBe(true);
  expect(
    (
      store.db
        .prepare("SELECT count(*) AS n FROM adit_history_sessions")
        .get() as { n: number }
    ).n,
  ).toBe(2);
});
it("keeps one persisted unlocked selection and normalizes legacy multi-selection", () => {
  const { root, store, history, achievements, workspace }=fixture();
  history.write(session(root));
  achievements.evaluate(workspace,options);
  expect(achievements.read(workspace).items.filter(i=>i.options.selected).map(i=>i.key)).toEqual(["marathon"]);
  achievements.savePreferences(workspace,{key:"hands-off",selected:true,showAgent:true});
  expect(achievements.read(workspace).items.filter(i=>i.options.selected).map(i=>i.key)).toEqual(["hands-off"]);
  store.db.prepare("UPDATE adit_achievement_export_items SET selected=1 WHERE workspace_id=?").run(workspace.id);
  const normalized=achievements.read(workspace);
  expect(normalized.items.filter(i=>i.options.selected).map(i=>i.key)).toEqual(["marathon"]);
  expect(normalized.items.find(i=>i.key==="hands-off")?.options.showAgent).toBe(true);
  expect(store.db.prepare("SELECT count(*) n FROM adit_achievement_export_items WHERE workspace_id=? AND selected=1").get(workspace.id)).toEqual({n:1});
  expect(()=>achievements.savePreferences(workspace,{key:"commander",selected:true})).toThrow(/unlocked/);
});
it("invalidates unsupported unlocks on scope changes while retaining audit and real zero states", () => {
  const { root, history, achievements, workspace, store } = fixture();
  history.write(session(root));
  achievements.evaluate(workspace, options);
  const changed = { ...workspace, providers: [] };
  expect(achievements.read(changed).status).toBe("pending");
  expect(() =>
    achievements.savePreferences(changed, { key: "marathon", selected: true }),
  ).toThrow();
  achievements.evaluate(changed, options);
  expect(achievements.read(changed).items).toHaveLength(8);
  expect(
    achievements
      .read(changed)
      .items.every((i) => i.value === 0 && i.tier === 0),
  ).toBe(true);
  expect(
    (
      store.db
        .prepare(
          "SELECT count(*) AS n FROM adit_achievement_unlocks WHERE valid=0",
        )
        .get() as { n: number }
    ).n,
  ).toBeGreaterThan(0);
  expect(() =>
    achievements.savePreferences(changed, { notify: "yes" }),
  ).toThrow();
});
it("deduplicates commits by SHA, excludes merges and awards only the original submitting session", () => {
  const { root, history, achievements, workspace, store } = fixture();
  history.write(session(root));
  history.write(session(root, "writer"));
  const w = { ...workspace, repositories: [root, root + "/copy"] };
  store.db
    .prepare(
      "INSERT INTO adit_attribution_runs (id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES ('r',?,1,'fixture','done',?)",
    )
    .run(w.id, start);
  for (let i = 0; i < 6; i++)
    for (const repo of w.repositories) {
      const sha = String(i).repeat(40);
      store.db
        .prepare(
          "INSERT INTO adit_local_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          repo,
          sha,
          "tree",
          start,
          "Me",
          "me@test",
          start + i,
          "Me",
          "me@test",
          "subject",
          "body",
          start,
        );
      store.db
        .prepare(
          "INSERT INTO adit_attribution_commits VALUES ('r',?,?, 'codex','main',NULL,NULL,'hash',?,0,0,0,0,0,0,0)",
        )
        .run(repo, sha, sha);
      if (i === 5)
        for (let p = 0; p < 2; p++)
          store.db
            .prepare("INSERT INTO adit_local_commit_parents VALUES (?,?,?,?)")
            .run(repo, sha, "parent" + p, p);
    }
  achievements.evaluate(w, options);
  const shipper = achievements.read(w).items.find((i) => i.key === "shipper")!;
  expect(shipper.value).toBe(5);
  expect(shipper.evidence.every((e) => e.sessionId === "main")).toBe(true);
  expect(shipper.unlocks[0].at).toBe(start + 4);
});
it("records the first evaluation failure rather than leaving it pending forever", () => {
  const { workspace, achievements } = fixture();
  expect(() =>
    achievements.evaluate(workspace, { ...options, timezone: "invalid" }),
  ).toThrow();
  expect(achievements.read(workspace).status).toBe("failed");
});
