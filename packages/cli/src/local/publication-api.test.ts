import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLocalServer } from "./server.js";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { PublicationApi } from "./publication-api.js";
import { LocalAnalytics, type PrScope } from "@varveai/adit-core";
let root: string, app: Awaited<ReturnType<typeof startLocalServer>>;
afterEach(async () => { await app?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
it("authenticates publication APIs and isolates drafts by workspace without publishing on preview", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-publication-api-")); mkdirSync(join(root, "other"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({ path: root, providers: ["claude"], repositories: [] });
  const other = app.store.saveWorkspace({ path: join(root, "other"), providers: ["claude"], repositories: [] });
  new StructuredHistory(app.store.db).write({ provider: "claude", id: "fixture", cwd: root, messages: [
    { key: "p", role: "user", content: "first question", raw: {} }, { key: "a", role: "assistant", content: "first answer", raw: {} },
    { key: "p2", role: "user", content: "second question", raw: {} }, { key: "a2", role: "assistant", content: "second answer", raw: {} },
  ] });
  const request = (path: string, method = "GET", body?: unknown, workspaceId = w.id, auth = true) => fetch(`${app.origin}/api/local${path}?workspaceId=${workspaceId}`, {
    method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${app.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect((await request("/shares", "GET", undefined, w.id, false)).status).toBe(401);
  const created = await request("/share-drafts", "POST", { provider: "claude", sessionId: "fixture" }); expect(created.status).toBe(201);
  const draft = await created.json() as any; expect(draft.snapshot.promptCount).toBe(2); expect(draft.gistConfigured).toBe(false);
  expect((await request(`/share-drafts/${draft.id}`, "GET", undefined, other.id)).status).toBe(404);
  expect((await request(`/share-drafts/${draft.id}`, "PATCH", { title: "foreign" }, other.id)).status).toBe(404);
  const selected = await (await request(`/share-drafts/${draft.id}`, "PATCH", { options: { scope: "selected", turnIds: [draft.turns[1].id] } })).json() as any;
  expect(selected.snapshot.promptCount).toBe(1); expect(JSON.stringify(selected.snapshot)).not.toContain("first answer");
  expect(selected.snapshot.title).toBe("second question"); expect(JSON.stringify(selected.snapshot)).not.toContain("first question");
  expect((await (await request("/shares")).json() as any).total).toBe(0);
  expect((await (await request("/pr-descriptions")).json() as any).total).toBe(0);
  expect((await request(`/share-drafts/${draft.id}/publish`, "POST", { version: selected.version, digest: selected.digest, idempotencyKey: "publish-test-123" })).status).toBe(409);
  expect((await request("/pr-descriptions", "POST", { scopeId: "forged" })).status).toBe(409);
});
it("keeps generation idempotent and recovers saved results after restart", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-pr-job-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({ path: root, providers: [], repositories: [root] });
  const analytics = new LocalAnalytics(app.store.db);
  let api = new PublicationApi(app.store, analytics.prices);
  try {
    const scope: PrScope = { repository: root, kind: "commits", head: null, base: null, headSha: null, baseSha: null, mergeBase: null, author: "fixture", digest: "fixed-range", commits: [{ sha: "a".repeat(40), subject: "fixture", included: true, reason: null }] };
    (api as any).scopes.set("scope", { workspaceId: w.id, scope, expires: Date.now() + 60000 });
    const url = new URL(`http://localhost/?workspaceId=${w.id}`), input = { scopeId: "scope", options: { lines: false }, idempotencyKey: "repeatable-job" };
    const first = await api.route("POST", "/pr-descriptions", url, input);
    const again = await api.route("POST", "/pr-descriptions", url, input);
    const id = (first!.value as any).jobId; expect((again!.value as any).jobId).toBe(id);
    await api.close();
    expect((app.store.db.prepare("SELECT count(*) n FROM adit_pr_descriptions").get() as any).n).toBe(1);
    // Simulate death after the result transaction committed, before status was acknowledged.
    app.store.db.prepare("UPDATE adit_pr_description_jobs SET status='running',result_id=NULL WHERE id=?").run(id);
    api = new PublicationApi(app.store, analytics.prices);
    const recovered = await api.route("GET", `/pr-description-jobs/${id}`, url, {});
    expect((recovered!.value as any).status).toBe("done"); expect((recovered!.value as any).result.id).toBe(id);
    await expect(api.route("GET", `/pr-description-jobs/${id}`, new URL("http://localhost/?workspaceId=missing"), {})).rejects.toThrow();
  } finally { await api.close(); await analytics.prices.close(); }
});
