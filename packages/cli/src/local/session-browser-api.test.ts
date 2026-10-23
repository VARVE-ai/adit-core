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
  expect((await get("/turn", { turnId: turn.id })).status).toBe(200);
  expect(
    (await get("/content", { eventId: turn.events[0].id, kind: "reply" }))
      .status,
  ).toBe(200);
  for (const route of ["/detail", "/turn", "/content", "/context"])
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
