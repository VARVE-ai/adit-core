import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalServer } from "./server.js";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
let root: string, app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
afterEach(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
it("allows authenticated single-turn edits and deletion, rejects stale and cross-session writes", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-session-edit-api-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({ path: root, providers: ["claude"], repositories: [] });
  const history = new StructuredHistory(app.store.db);
  for (const id of ["first", "second"]) history.write({ provider: "claude", id, cwd: root, messages: [
    { key: "u1", role: "user", content: "first prompt", raw: {} },
    { key: "a1", role: "assistant", content: "first reply", raw: {} },
    { key: "u2", role: "user", content: "keep prompt", raw: {} },
    { key: "a2", role: "assistant", content: "keep reply", raw: {} },
  ] });
  const call = (route: string, method = "GET", input?: unknown, params: Record<string, string> = {}, auth = true) => fetch(
    app!.origin + "/api/local/sessions" + route + "?" + new URLSearchParams({ workspaceId: w.id, provider: "claude", id: "first", ...params }),
    { method, headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer " + app!.token } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) },
  );
  const detail = await (await call("/detail")).json() as any;
  const turnId = detail.turns[0].id;
  const draft = await (await call("/turn/edit", "GET", undefined, { turnId })).json() as any;
  const update = { revision: draft.revision, changes: [{ id: draft.blocks[1].id, text: "a long updated reply\n".repeat(4000) }] };
  expect((await call("/turn", "PATCH", update, { turnId }, false)).status).toBe(403);
  expect((await call("/turn", "PATCH", update, { id: "second", turnId })).status).toBe(404);
  expect((await call("/turn", "PATCH", update, { turnId })).status).toBe(200);
  expect((await call("/turn", "PATCH", update, { turnId })).status).toBe(409);
  expect((await (await call("/turn/edit", "GET", undefined, { turnId })).json() as any).blocks[1].text).toBe(update.changes[0].text);
  const url = app.origin + "/api/local/sessions/turn?" + new URLSearchParams({ workspaceId: w.id, provider: "claude", id: "first", turnId });
  expect((await fetch(url, { method: "DELETE", headers: { origin: "http://other.invalid", "x-adit-local": "1" }, body: JSON.stringify({ revision: draft.revision + 1 }) })).status).toBe(403);
  expect((await call("/turn", "DELETE", { revision: draft.revision + 1 }, { turnId })).status).toBe(200);
  expect((await call("/turn", "GET", undefined, { turnId })).status).toBe(404);
  const after = await (await call("/detail")).json() as any;
  expect(after.turns.map((t: any) => t.prompt)).toEqual(["keep prompt"]);
  expect(after.session.prompts).toBe(1);
  expect((await call("", "DELETE", { revision: 1 })).status).toBe(404);
});
it("authenticates session browsing and enforces workspace boundaries for all detail endpoints", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-session-api-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({
    path: root,
    providers: ["claude"],
    repositories: [],
  });
  const history = new StructuredHistory(app.store.db);
  for (const [id, cwd] of [
    ["inside", root],
    ["outside", root + "-other"],
  ])
    history.write({
      provider: "claude",
      id,
      cwd,
      messages: [
        { key: "p", role: "user", content: "question", raw: {} },
        { key: "a", role: "assistant", content: "answer", raw: {} },
      ],
    });
  const get = (
    route: string,
    params: Record<string, string> = {},
    auth = true,
  ) =>
    fetch(
      app!.origin +
        "/api/local/sessions" +
        route +
        "?" +
        new URLSearchParams({
          workspaceId: w.id,
          provider: "claude",
          id: "inside",
          ...params,
        }),
      { headers: auth ? { authorization: "Bearer " + app!.token } : {} },
    );
  expect((await get("", {}, false)).status).toBe(403);
  const list = (await (await get("")).json()) as any;
  expect(list.total).toBe(1);
  const detail = (await (await get("/detail")).json()) as any;
  expect(detail.turns[0].prompt).toBe("question");
  const turn = detail.turns[0];
  expect((await get("/preview", { turnId: turn.id }, false)).status).toBe(403);
  expect(await (await get("/preview", { turnId: turn.id })).json()).toMatchObject({ targetTurnId: turn.id, turns: [{ prompt: "question" }] });
  expect(await (await get("/detail", { turnId: turn.id })).json()).toMatchObject({ matchTurnId: turn.id });
  expect((await get("/turn", { turnId: turn.id })).status).toBe(200);
  expect(
    (await get("/content", { eventId: turn.events[0].id, kind: "reply" }))
      .status,
  ).toBe(200);
  for (const route of ["/detail", "/preview", "/turn", "/content", "/context"])
    expect(
      (
        await get(route, {
          id: "outside",
          turnId: turn.id,
          eventId: turn.events[0].id,
        })
      ).status,
    ).toBe(404);
  for (const kind of ["tool-input", "tool-output"])
    expect(
      (
        await get("/content", {
          id: "outside",
          eventId: turn.events[0].id,
          kind,
        })
      ).status,
    ).toBe(404);
  expect((await get("/content", { eventId: "missing" })).status).toBe(404);
});

it("passes the browser timezone to daily session grouping and rejects invalid zones", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-session-day-api-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({ path: root, providers: ["claude"], repositories: [] });
  new StructuredHistory(app.store.db).write({ provider: "claude", id: "midnight", cwd: w.path, messages: [
    { key: "p", role: "user", content: "question", timestamp: "2026-10-20T15:59:00Z", raw: {} },
    { key: "a", role: "assistant", content: "answer", timestamp: "2026-10-20T16:01:00Z", raw: {} },
  ] });
  const get = (timezone: string) => fetch(app!.origin + "/api/local/sessions?" + new URLSearchParams({ workspaceId: w.id, timezone }), {
    headers: { authorization: "Bearer " + app!.token },
  });
  const local = await (await get("Asia/Shanghai")).json() as any;
  expect(local.items.map((s: any) => [s.day, s.prompts])).toEqual([["2026-10-21", 0], ["2026-10-20", 1]]);
  expect((await (await get("UTC")).json() as any).total).toBe(1);
  expect((await get("invalid/zone")).status).toBe(400);
});

it("serves 50 detail entries per page including a prompt only once", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-session-detail-api-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({ path: root, providers: ["claude"], repositories: [] });
  new StructuredHistory(app.store.db).write({ provider: "claude", id: "long", cwd: w.path, messages: [
    { key: "p", role: "user", content: "question", raw: {} },
    ...Array.from({ length: 103 }, (_, i) => ({ key: `a${i}`, role: "assistant", content: `reply ${i}`, raw: {} })),
  ] });
  const get = async (offset: number) => (await fetch(app!.origin + "/api/local/sessions/detail?" + new URLSearchParams({
    workspaceId: w.id, provider: "claude", id: "long", offset: String(offset),
  }), { headers: { authorization: "Bearer " + app!.token } })).json() as Promise<any>;
  const first = await get(0), second = await get(first.nextOffset), last = await get(second.nextOffset);
  expect([first, second, last].map(p => p.turns[0].events.length)).toEqual([49,50,4]);
  expect([first, second, last].map(p => p.turns[0].promptVisible)).toEqual([true,false,false]);
  expect(last.nextOffset).toBeNull();
});

it("passes day and timezone through detail, turn and context reads while keeping full-session links", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-session-selected-day-api-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({ path: root, providers: ["claude"], repositories: [] });
  new StructuredHistory(app.store.db).write({ provider: "claude", id: "days", cwd: w.path, messages: [
    { key: "context", role: "system", content: "prior context", timestamp: "2026-10-20T15:58:00Z", raw: {} },
    { key: "p", role: "user", content: "prior question", timestamp: "2026-10-20T15:59:00Z", raw: {} },
    { key: "a", role: "assistant", content: "selected day answer", timestamp: "2026-10-20T16:01:00Z", raw: {} },
  ] });
  const get = (route: string, params: Record<string, string> = {}) => fetch(app!.origin + "/api/local/sessions/" + route + "?" + new URLSearchParams({
    workspaceId: w.id, provider: "claude", id: "days", timezone: "Asia/Shanghai", ...params,
  }), { headers: { "x-adit-local": "1" } });
  const selected = await (await get("detail", { day: "2026-10-21" })).json() as any;
  expect(selected.session).toMatchObject({ prompts: 0, messages: 1 });
  expect(selected.turns[0]).toMatchObject({ promptVisible: false, events: [{ text: "selected day answer" }] });
  expect(selected.context).toEqual([]);
  const turnId = selected.turns[0].id;
  const prior = await (await get("turn", { turnId, day: "2026-10-20" })).json() as any;
  expect(prior.events).toEqual([]);
  expect((await (await get("context", { day: "2026-10-21" })).json() as any).events).toEqual([]);
  expect((await (await get("detail", { turnId })).json() as any).session.messages).toBe(3);
  expect((await get("detail", { day: "2026-02-30" })).status).toBe(400);
  expect((await get("detail", { day: "2026-10-21", timezone: "invalid/zone" })).status).toBe(400);
  expect((await (await get("detail", { day: "unknown" })).json() as any).session.messages).toBe(0);
});
