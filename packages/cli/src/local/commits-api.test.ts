import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLocalServer } from "./server.js";
let app: Awaited<ReturnType<typeof startLocalServer>>, root: string;
afterEach(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
it("authenticates commit routes, returns empty data and rejects unconfigured Git paths", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-commit-api-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({
    path: root,
    repositories: [],
    providers: [],
  });
  for (const path of ["/commits", "/commits/sources"])
    expect(
      (await fetch(app.origin + "/api/local" + path + "?workspaceId=" + w.id))
        .status,
    ).toBe(403);
  const api = (path: string) =>
    fetch(app.origin + "/api/local" + path, {
      headers: { authorization: "Bearer " + app.token },
    });
  const response = await api("/commits?workspaceId=" + w.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    repositories: [],
    commits: [],
  });
  expect((await api("/commits?workspaceId=missing")).status).toBe(404);
  expect(
    (
      await api(
        `/commits/sources?workspaceId=${w.id}&repository=${encodeURIComponent(root)}&sha=${"a".repeat(40)}`,
      )
    ).status,
  ).toBe(400);
});

it("pages commits in SQL and filters across all rows while preserving workspace totals", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-commit-pages-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({ path: root, repositories: [root], providers: [] });
  const insert = app.store.db.prepare("INSERT INTO adit_local_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 103; i++) insert.run(root, String(i).padStart(40, "0"), "tree", 1000 - i, "Fixture", "fixture@example.test", 1000 - i, "Fixture", "fixture@example.test", `Commit ${i}`, "", 1);
  insert.run("outside-workspace", "a".repeat(40), "tree", 2000, "Fixture", "fixture@example.test", 2000, "Fixture", "fixture@example.test", "Other project", "", 1);
  const request = async (params = "") => {
    const response = await fetch(`${app.origin}/api/local/commits?workspaceId=${w.id}${params}`, { headers: { authorization: "Bearer " + app.token } });
    expect(response.status).toBe(200);
    return response.json();
  };
  const first = await request(), second = await request("&offset=50"), last = await request("&offset=100");
  expect(first.commits).toHaveLength(50); expect(first.nextOffset).toBe(50);
  expect(second.commits).toHaveLength(50); expect(second.nextOffset).toBe(100);
  expect(last.commits).toHaveLength(3); expect(last.nextOffset).toBeNull();
  expect(new Set([...first.commits, ...second.commits, ...last.commits].map(c => c.sha)).size).toBe(103);
  expect(first.summary).toEqual({ total: 103, linked: 0, first: 898 });
  const search = await request("&q=COMMIT%20102");
  expect(search.total).toBe(1); expect(search.commits[0].subject).toBe("Commit 102");
  expect(search.summary).toEqual(first.summary);
  const empty = await request("&repository=outside-workspace");
  expect(empty.commits).toHaveLength(0); expect(empty.total).toBe(0); expect(empty.summary).toEqual(first.summary);
  expect((await request("&offset=500")).nextOffset).toBeNull();
  expect((await request("&filter=linked")).total).toBe(0);
  // Unanalyzed commits keep the existing distinction from analyzed/unmatched commits.
  expect((await request("&filter=unlinked")).total).toBe(0);
  expect((await fetch(`${app.origin}/api/local/commits?workspaceId=${w.id}&offset=-1`, { headers: { authorization: "Bearer " + app.token } })).status).toBe(400);
});
