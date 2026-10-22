import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalStore, LocalAnalytics, LocalSharing } from "@varveai/adit-core";
import { createHistorySchema } from "../../../core/src/local-history/schema.js";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { GistPublisher } from "./gist-publisher.js";
let root: string, store: LocalStore, analytics: LocalAnalytics;
afterEach(async () => { await analytics?.prices.close(); store?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), "adit-gist-test-")); store = new LocalStore(join(root, "state")); createHistorySchema(store.db); analytics = new LocalAnalytics(store.db);
  const w = store.saveWorkspace({ path: root, providers: ["claude"], repositories: [] });
  new StructuredHistory(store.db).write({ provider: "claude", id: "session", cwd: root, messages: [{ key: "p", role: "user", content: "Safe fixture", raw: {} }] });
  const sharing = new LocalSharing(store.db, analytics.prices), draft = sharing.create(w, "claude", "session");
  return { w, sharing, draft, input: { version: draft.version, digest: draft.digest, idempotencyKey: "publish-test-123" } };
}
it("publishes only the reviewed safe payload and returns the same result on retry", async () => {
  const { w, sharing, draft, input } = fixture();
  const request = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body); expect(body.public).toBe(false);
    const snapshot = JSON.parse(body.files["adit-session.json"].content);
    expect(snapshot).toEqual(draft.snapshot); expect(snapshot).not.toHaveProperty("options");
    expect(init.body).not.toContain(root); expect(init.body).not.toContain("FAKE_CREDENTIAL");
    return new Response(JSON.stringify({ id: "abcdef123", html_url: "https://gist.github.com/test/abcdef123", history: [{ version: "a".repeat(40) }] }));
  });
  const publisher = new GistPublisher(sharing, { read: async () => "FAKE_CREDENTIAL" }, request as typeof fetch, "https://example.org/share-reader.html");
  const result = await publisher.publish(w, draft.id, input);
  expect(result.status).toBe("published"); expect(result.viewerUrl).toContain("#gist=abcdef123&revision=");
  await publisher.publish(w, draft.id, input); expect(request).toHaveBeenCalledTimes(1);
});
it("reconciles an uncertain create without posting a second Gist", async () => {
  const { w, sharing, draft, input } = fixture();
  const request = vi.fn(async (_url: any, init: any) => {
    if (init.method === "POST") throw new Error("connection lost");
    if (_url.includes(`/gists/abcdef123/`)) return new Response(JSON.stringify({ files: { "adit-session.json": { content: JSON.stringify(draft.snapshot) } } }));
    return new Response(JSON.stringify([{ id: "abcdef123", description: `ADIT share ${draft.version}`, html_url: "https://gist.github.com/test/abcdef123", history: [{ version: "a".repeat(40) }] }]));
  });
  const publisher = new GistPublisher(sharing, { read: async () => "FAKE_CREDENTIAL" }, request as typeof fetch);
  await expect(publisher.publish(w, draft.id, input)).rejects.toThrow("confirm"); expect(sharing.read(w, draft.id).status).toBe("publish_unknown");
  await publisher.publish(w, draft.id, input); expect(sharing.read(w, draft.id).status).toBe("published");
  expect(request.mock.calls.filter(c => c[1].method === "POST")).toHaveLength(1);
});
it("does not accept a changed remote snapshot while reconciling a timeout", async () => {
  const { w, sharing, draft, input } = fixture();
  const request = vi.fn(async (url: any, init: any) => {
    if (init.method === "POST") throw new Error("lost response");
    if (url.includes(`/gists/abcdef123/`)) return new Response(JSON.stringify({ files: { "adit-session.json": { content: "{}" } } }));
    return new Response(JSON.stringify([{ id: "abcdef123", description: `ADIT share ${draft.version}`, html_url: "https://gist.github.com/test/abcdef123", history: [{ version: "a".repeat(40) }] }]));
  });
  const publisher = new GistPublisher(sharing, { read: async () => "FAKE_CREDENTIAL" }, request as typeof fetch);
  await expect(publisher.publish(w, draft.id, input)).rejects.toThrow("confirm");
  await expect(publisher.publish(w, draft.id, input)).rejects.toThrow("no longer matches");
  expect(sharing.list(w).total).toBe(0); expect(sharing.read(w, draft.id).status).toBe("publish_unknown");
});
it("does not mark denied requests as published", async () => {
  const { w, sharing, draft, input } = fixture();
  const publisher = new GistPublisher(sharing, { read: async () => "FAKE_CREDENTIAL" }, (async () => new Response("denied", { status: 401 })) as typeof fetch);
  await expect(publisher.publish(w, draft.id, input)).rejects.toThrow("invalid or expired");
  expect(sharing.read(w, draft.id).status).toBe("failed"); expect(sharing.list(w).total).toBe(0);
});
it("rejects an invalid reader address before a remote create or local publishing transition", async () => {
  const { w, sharing, draft, input } = fixture();
  const request = vi.fn();
  const publisher = new GistPublisher(sharing, { read: async () => "FAKE_CREDENTIAL" }, request, "http://localhost/share-reader.html");
  await expect(publisher.publish(w, draft.id, input)).rejects.toThrow("public HTTPS");
  expect(request).not.toHaveBeenCalled(); expect(sharing.read(w, draft.id).status).toBe("ready");
});
