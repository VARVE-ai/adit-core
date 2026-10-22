import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { startLocalServer } from "./server.js";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
let app: Awaited<ReturnType<typeof startLocalServer>> | undefined,
  root = "";
afterEach(async () => {
  await app?.close();
  app = undefined;
  if (root && resolve(root).startsWith(resolve(tmpdir())))
    rmSync(root, { recursive: true, force: true });
});
it("authenticates inspection, masks API output, scans asynchronously and preserves user status after rescan", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-inspection-api-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const workspace = app.store.saveWorkspace({
    path: root,
    providers: ["claude"],
    repositories: [],
  });
  const key =
    "sk-ant-" +
    createHash("sha256").update("api-secret-synthetic").digest("hex");
  new StructuredHistory(app.store.db).write({
    id: "fixture",
    provider: "claude",
    cwd: root,
    messages: [
      { key: "one", role: "user", content: key, raw: {} },
      { key: "reply", role: "assistant", content: key, raw: {} },
    ],
  });
  const base = app.origin + "/api/local/inspection";
  expect((await fetch(base + "?workspaceId=" + workspace.id)).status).toBe(401);
  const api = async (suffix = "", method = "GET", body?: unknown) =>
    fetch(
      base +
        suffix +
        (suffix.includes("?") ? "&" : "?") +
        "workspaceId=" +
        workspace.id,
      {
        method,
        headers: {
          authorization: "Bearer " + app!.token,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  expect((await api("/scan", "POST", {})).status).toBe(202);
  let data: any;
  await expect
    .poll(async () => {
      data = await (await api()).json();
      return data.run?.status;
    })
    .toBe("done");
  expect(data.pendingDefinite).toBe(2);
  expect(JSON.stringify(data)).not.toContain(key);
  const finding = data.items[0];
  expect(data.items).toHaveLength(2);
  const sessions = (await (await api("?view=sessions")).json()) as any;
  expect(sessions.counts).toEqual(data.counts);
  expect(sessions.items).toEqual([]);
  expect(sessions.sessions).toMatchObject([
    { provider: "claude", sessionId: "fixture", count: 2 },
  ]);
  const sessionFindings = (await (
    await api("?provider=claude&sessionId=fixture")
  ).json()) as any;
  expect(sessionFindings.items).toHaveLength(2);
  expect((await api("?provider=claude")).status).toBe(400);
  const group = {
    provider: "claude",
    sessionId: "fixture",
    from: "pending",
    status: "handled",
    rule: "",
  };
  expect(await (await api("/session-status", "PATCH", group)).json()).toEqual({
    ok: true,
    updated: 2,
  });
  expect(((await (await api()).json()) as any).counts).toEqual({
    pending: 0,
    handled: 2,
    ignored: 0,
  });
  expect(
    await (
      await api("/session-status", "PATCH", {
        ...group,
        from: "handled",
        status: "pending",
      })
    ).json(),
  ).toEqual({ ok: true, updated: 2 });
  expect(
    (await api("/session-status", "PATCH", { ...group, rule: "missing" }))
      .status,
  ).toBe(400);
  expect(
    (await api("/session-status", "PATCH", { ...group, from: "invalid" }))
      .status,
  ).toBe(400);
  expect(
    (await api("/session-status", "PATCH", { ...group, provider: "" })).status,
  ).toBe(400);
  const detailResponse = await api(
    "/detail?id=" + encodeURIComponent(finding.id),
  );
  const detail = (await detailResponse.json()) as any;
  expect(detailResponse.status).toBe(200);
  expect(detail.id).toBe(finding.id);
  expect(JSON.stringify(detail)).not.toContain(key);
  expect((await api("/detail?id=missing")).status).toBe(404);
  expect(
    (
      await api("/status", "PATCH", {
        id: "turn_" + finding.id,
        status: "handled",
      })
    ).status,
  ).toBe(404);
  expect(
    (await api("/status", "PATCH", { id: finding.id, status: "handled" }))
      .status,
  ).toBe(200);
  await api("/scan", "POST", {});
  await expect
    .poll(async () => {
      data = await (await api()).json();
      return data.run.status;
    })
    .toBe("done");
  expect(data.counts).toEqual({ pending: 1, handled: 1, ignored: 0 });
  expect(
    (await api("/status", "PATCH", { id: finding.id, status: "invented" }))
      .status,
  ).toBe(400);
  const handled = (await (
    await api("/detail?id=" + encodeURIComponent(finding.id))
  ).json()) as any;
  expect(handled.status).toBe("handled");
  expect(data.items).toHaveLength(1);
  expect(data.items[0].id).not.toBe(finding.id);
  expect((await api("/folder", "POST", { id: finding.id })).status).toBe(404);
});
it("finishes shutdown with an incomplete browser request instead of retaining the daemon lock", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-inspection-shutdown-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const url = new URL(app.origin),
    socket = createConnection({ host: url.hostname, port: Number(url.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `POST /api/local/session HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${url.origin}\r\nContent-Length: 100\r\n\r\n{`,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await app.close();
  socket.destroy();
  app = undefined;
}, 3000);
