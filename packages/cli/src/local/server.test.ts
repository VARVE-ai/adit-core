import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { request } from "node:http";
import { startLocalServer } from "./server.js";
import { BROWSER_SESSION_MAX_AGE } from "./browser-sessions.js";

let app: Awaited<ReturnType<typeof startLocalServer>>;
let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "adit-api-test-"));
  // Discovery must not inspect the test runner's real agent logs.
  for (const name of [
    "CLAUDE_PROJECTS_DIR",
    "CODEX_SESSIONS_DIR",
    "GEMINI_DIR",
    "DEEPSEEK_TUI_SESSIONS_DIR",
  ])
    vi.stubEnv(name, join(root, "missing"));
  app = await startLocalServer({ directory: join(root, "state") });
});
afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function api(
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return fetch(app.origin + "/api/local" + path, {
    method,
    headers: {
      authorization: `Bearer ${app.token}`,
      "content-type": "application/json",
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
it("lists available Windows drives and opens a drive letter at its root", async () => {
  const response = await api("/directories/list", "POST", { path: root });
  expect(response.status).toBe(200);
  const listing = (await response.json()) as { drives: string[] };
  if (process.platform !== "win32") {
    expect(listing.drives).toEqual([]);
    return;
  }
  const currentDrive = parse(root).root;
  expect(listing.drives.map((d) => d.toLowerCase())).toContain(
    currentDrive.toLowerCase(),
  );
  for (const drive of listing.drives) expect(drive).toMatch(/^[A-Z]:\\$/);
  const opened = await api("/directories/list", "POST", {
    path: currentDrive.slice(0, 2),
  });
  expect(opened.status).toBe(200);
  expect(await opened.json()).toMatchObject({
    path: currentDrive,
    parent: currentDrive,
  });
});
it("authenticates overview, validates scope and returns real empty structured metrics", async () => {
  const created = await api("/workspaces", "POST", {
    path: root,
    name: "overview",
    providers: [],
  });
  const workspace = (await created.json()) as { id: string };
  expect(
    (
      await fetch(
        app.origin + "/api/local/overview?workspaceId=" + workspace.id,
      )
    ).status,
  ).toBe(401);
  const response = await api(
    `/overview?workspaceId=${workspace.id}&range=7d&timezone=Asia%2FShanghai&year=2026`,
  );
  expect(response.status).toBe(200);
  const data = (await response.json()) as any;
  expect(data.summary).toMatchObject({
    sessions: 0,
    messages: 0,
    prompts: 0,
    totalCommits: 0,
    estimatedCost: null,
  });
  expect(data.activity.hours).toHaveLength(24);
  expect(data.activity.days).toHaveLength(365);
  expect(
    (await api(`/overview?workspaceId=${workspace.id}&range=invalid`)).status,
  ).toBe(400);
  expect(
    (await api(`/overview?workspaceId=${workspace.id}&year=9999`)).status,
  ).toBe(400);
  expect(
    (await api(`/overview?workspaceId=${workspace.id}&provider=unknown`))
      .status,
  ).toBe(400);
});
it("imports a selected local export into an explicit workspace through the authenticated API", async () => {
  const workspacePath = join(root, "import-work");
  mkdirSync(workspacePath);
  const created = await api("/workspaces", "POST", {
    path: workspacePath,
    name: "import target",
    providers: [],
  });
  const workspace = (await created.json()) as { id: string };
  const path = join(root, "export.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        uuid: "conversation",
        chat_messages: [{ uuid: "m", sender: "human", text: "hello" }],
      },
    ]),
  );
  expect(
    (
      await fetch(app.origin + "/api/local/imports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          path,
          provider: "claude-ai",
        }),
      })
    ).status,
  ).toBe(401);
  const imported = await api("/imports", "POST", {
    workspaceId: workspace.id,
    path,
    provider: "claude-ai",
  });
  expect(imported.status).toBe(201);
  expect(await imported.json()).toMatchObject({
    imported: 1,
    counts: { "claude-ai": 1 },
  });
});
it("requires authorization and rejects hostile Host or Origin", async () => {
  expect((await fetch(app.origin + "/api/local/state")).status).toBe(401);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      app.origin + "/api/local/state",
      {
        headers: {
          host: "foreign.example",
          authorization: `Bearer ${app.token}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  expect(status).toBe(403);
  expect(
    (
      await fetch(app.origin + "/api/local/session", {
        method: "POST",
        headers: {
          origin: "https://foreign.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: app.token }),
      })
    ).status,
  ).toBe(403);
});
it("handles non-ASCII invalid tokens without timingSafeEqual exceptions", async () => {
  expect(
    (
      await fetch(app.origin + "/api/local/session", {
        method: "POST",
        headers: { origin: app.origin, "content-type": "application/json" },
        body: JSON.stringify({ token: "\u00e9".repeat(app.token.length) }),
      })
    ).status,
  ).toBe(401);
});
it("requires same-origin headers for cookie-authenticated writes", async () => {
  const login = await fetch(app.origin + "/api/local/session", {
    method: "POST",
    headers: { origin: app.origin, "content-type": "application/json" },
    body: JSON.stringify({ token: app.token }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  expect(
    (await fetch(app.origin + "/api/local/state", { headers: { cookie } }))
      .status,
  ).toBe(200);
  expect(
    (
      await fetch(app.origin + "/api/local/collection/run", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
});
it("preserves browser authorization across service restarts while rotating the CLI token", async () => {
  const previousToken = app.token;
  const login = await fetch(app.origin + "/api/local/session", {
    method: "POST",
    headers: { origin: app.origin, "content-type": "application/json" },
    body: JSON.stringify({ token: previousToken }),
  });
  expect(login.status).toBe(200);
  const header = login.headers.get("set-cookie")!;
  expect(header).toContain("HttpOnly; SameSite=Strict");
  expect(header).toContain(`Max-Age=${BROWSER_SESSION_MAX_AGE}`);
  const cookie = header.split(";")[0];
  const persisted = JSON.stringify(
    app.store.db.prepare("SELECT * FROM adit_local_browser_sessions").all(),
  );
  expect(persisted).not.toContain(cookie.split("=")[1]);
  await app.close();
  app = await startLocalServer({ directory: join(root, "state") });
  expect(app.token).not.toBe(previousToken);
  expect(
    (await fetch(app.origin + "/api/local/state", { headers: { cookie } }))
      .status,
  ).toBe(200);
  expect(
    (
      await fetch(app.origin + "/api/local/state", {
        headers: { authorization: `Bearer ${previousToken}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(app.origin + "/api/local/state", {
        headers: { cookie: "adit_local=" + "a".repeat(64) },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(app.origin + "/api/local/collection/run", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  const changes = app.store.db.prepare("SELECT total_changes() n").get();
  await fetch(app.origin + "/api/local/state", { headers: { cookie } });
  expect(app.store.db.prepare("SELECT total_changes() n").get()).toEqual(
    changes,
  );
  const expiresAt = (
    app.store.db
      .prepare("SELECT expires_at FROM adit_local_browser_sessions")
      .get() as { expires_at: number }
  ).expires_at;
  const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt);
  try {
    expect(
      (await fetch(app.origin + "/api/local/state", { headers: { cookie } }))
        .status,
    ).toBe(401);
  } finally {
    clock.mockRestore();
  }
});
it("does not authorize browser cookies issued by a different local data directory", async () => {
  const login = await fetch(app.origin + "/api/local/session", {
    method: "POST",
    headers: { origin: app.origin, "content-type": "application/json" },
    body: JSON.stringify({ token: app.token }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  await app.close();
  app = await startLocalServer({ directory: join(root, "other-state") });
  expect(
    (await fetch(app.origin + "/api/local/state", { headers: { cookie } }))
      .status,
  ).toBe(401);
});
it("validates repository scope on create and update", async () => {
  const path = join(root, "workspace"),
    outside = join(root, "outside");
  mkdirSync(path);
  mkdirSync(outside);
  mkdirSync(join(outside, ".git"));
  expect(
    (await api("/workspaces", "POST", { path, repositories: [outside] }))
      .status,
  ).toBe(400);
  const created = await api("/workspaces", "POST", {
    path,
    name: "example",
    providers: ["codex"],
  });
  expect(created.status).toBe(201);
  const workspace = (await created.json()) as { id: string; version: number };
  expect(
    (
      await api(`/workspaces/${workspace.id}`, "PATCH", {
        version: workspace.version,
        repositories: [outside],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api(`/workspaces/${workspace.id}`, "PATCH", {
        version: workspace.version,
        cloud: { enabled: true, mode: "automatic", interval: 15 },
      })
    ).status,
  ).toBe(200);
  expect(app.store.jobs()).toHaveLength(0);
});
it("rejects unsupported sources and returns no credentials", async () => {
  expect(
    (
      await api("/providers/unknown-agent", "PATCH", {
        version: 0,
        enabled: true,
        homes: [],
      })
    ).status,
  ).toBe(400);
  const response = JSON.stringify(await (await api("/state")).json());
  expect(response).not.toContain(app.token);
  expect(response).not.toContain("accessToken");
});
it("runs local collection with no external engine and deduplicates requests", async () => {
  const path = join(root, "workspace"),
    source = join(root, "source");
  mkdirSync(path);
  mkdirSync(source);
  vi.stubEnv("CODEX_SESSIONS_DIR", source);
  writeFileSync(
    join(source, "rollout-test.jsonl"),
    [
      { type: "session_meta", payload: { id: "test-session", cwd: path } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: "test prompt" },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const workspace = app.store.saveWorkspace({ path, providers: ["codex"] });
  const first = app.collector.collect(workspace.id);
  expect(app.collector.collect(workspace.id).id).toBe(first.id);
  for (let i = 0; i < 100; i++) {
    const job = app.store
      .jobs<{ id: string; status: string }>()
      .find((j) => j.id === first.id);
    if (job?.status === "done") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(app.store.jobs<{ status: string }>()[0].status).toBe("done");
  expect(app.collector.snapshot(workspace)).toEqual({ codex: 1 });
  expect(app.store.workspace(workspace.id).started).toBe(true);
});
