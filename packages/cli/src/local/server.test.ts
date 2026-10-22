import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { request } from "node:http";
import { startLocalServer } from "./server.js";
import { BROWSER_SESSION_MAX_AGE } from "./browser-sessions.js";
import * as githubCredential from "./github-credential.js";
import { LocalStateError } from "@varveai/adit-core";

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
  const registration = join(root, "test-login-entry");
  app = await startLocalServer({
    directory: join(root, "state"),
    startupRegistration: {
      supported: true, path: registration,
      installed: () => existsSync(registration),
      install: async () => { writeFileSync(registration, "test"); },
      remove: async () => { rmSync(registration, { force: true }); },
    },
  });
});
afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
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
it("imports a local GitHub account only after an authenticated explicit POST", async () => {
  const imported = vi.spyOn(githubCredential, "importGitHubCredential").mockResolvedValue({ configured: true, account: "test-user" });
  const workspace = app.store.saveWorkspace({ path: root, providers: [] });
  const endpoint = `/workspaces/${workspace.id}/gist-credential`;
  await api("/state");
  expect((await api(endpoint)).status).toBe(405);
  expect((await fetch(app.origin + "/api/local" + endpoint, { method: "POST" })).status).toBe(401);
  expect((await api("/workspaces/missing/gist-credential", "POST", {})).status).toBe(404);
  expect(imported).not.toHaveBeenCalled();
  const result = await api(endpoint, "POST", {});
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ configured: true, account: "test-user" });
  expect(imported).toHaveBeenCalledWith(expect.anything(), workspace.id);
});
it("prevents concurrent credential changes or deletion while importing and unlocks after failure", async () => {
  let rejectImport!: (error: Error) => void;
  const imported = vi.spyOn(githubCredential, "importGitHubCredential").mockImplementation(() => new Promise((_resolve, reject) => { rejectImport = reject; }));
  const workspace = app.store.saveWorkspace({ path: root, providers: [] });
  const endpoint = `/workspaces/${workspace.id}/gist-credential`;
  const pending = api(endpoint, "POST", {});
  await vi.waitFor(() => expect(imported).toHaveBeenCalledOnce());
  expect((await api(endpoint, "POST", {})).status).toBe(409);
  expect((await api(endpoint, "PUT", { token: "TEST_ONLY" })).status).toBe(409);
  expect((await api(`/workspaces/${workspace.id}`, "DELETE", { version: workspace.version })).status).toBe(409);
  rejectImport(new LocalStateError("The local GitHub sign-in has expired. Sign in again and retry.", 401));
  expect((await pending).status).toBe(401);
  imported.mockResolvedValue({ configured: true, account: "test-user" });
  expect((await api(endpoint, "POST", {})).status).toBe(200);
});
it("checks directory availability on page state and repairs the path without replacing project identity",async()=>{
  const original=join(root,"original"),moved=join(root,"moved");mkdirSync(original);
  const w=app.store.saveWorkspace({path:original,providers:["codex"]});
  renameSync(original,moved);
  const state=await (await api("/state")).json() as any;
  expect(state.workspaces.find((item:any)=>item.id===w.id).directoryAvailable).toBe(false);
  expect((await api(`/workspaces/${w.id}/collect`,"POST",{})).status).toBe(409);
  const response=await api(`/workspaces/${w.id}`,"PATCH",{version:w.version,path:moved});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({id:w.id,path:moved,directoryAvailable:true});
  const resolved=await (await api(`/projects/resolve?path=${encodeURIComponent(moved)}`)).json();
  expect(resolved).toMatchObject({projectId:w.id,source:"registry"});
});
it("requires local authentication and validates device token input without changing the account", async () => {
  expect((await fetch(app.origin + "/api/local/account/token", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "adit_test" }),
  })).status).toBe(401);
  const response = await api("/account/token", "POST", { token: "wrong_test_token" });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("wrong_test_token");
  expect(await (await api("/account")).json()).toMatchObject({ connected: false, auth: "disconnected" });
});
it("authenticates achievement reads and validates workspace-scoped preferences", async () => {
  const workspace = app.store.saveWorkspace({ path: root, providers: [], repositories: [] });
  const query = `?workspaceId=${workspace.id}`;
  expect((await fetch(app.origin + "/api/local/achievements" + query)).status).toBe(401);
  const response = await api("/achievements" + query);
  const data = await response.json() as { status: string; items: unknown[] };
  expect(data.status).toBe("pending"); expect(data.items).toHaveLength(8);
  expect((await api("/achievements/preferences" + query,"PATCH",{key:"marathon",selected:true})).status).toBe(409);
  expect((await api("/achievements/preferences" + query,"PATCH",{notify:"yes"})).status).toBe(400);
  expect((await api("/achievements/preferences" + query,"PATCH",{notify:false})).status).toBe(200);
  expect((await api("/achievements/acknowledge" + query,"POST",{ids:["another-workspace-unlock"]})).status).toBe(200);
  expect((await api("/achievements?workspaceId=missing")).status).toBe(404);
});
it("requires authenticated explicit login startup before automatic sync, including API callers", async () => {
  const automatic = { enabled: true, mode: "automatic", interval: 5 };
  expect((await fetch(app.origin + "/api/local/startup", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, version: 0 }),
  })).status).toBe(401);
  expect((await api("/workspaces", "POST", { path: root, cloud: automatic })).status).toBe(409);
  expect(app.store.workspaces()).toHaveLength(0);
  expect((await api("/startup", "PATCH", { enabled: true, version: 0 })).status).toBe(200);
  const response = await api("/workspaces", "POST", { path: root, cloud: automatic });
  expect(response.status).toBe(201);
  const workspace = await response.json() as { id: string; version: number };
  expect((await api("/startup", "PATCH", { enabled: false, version: 1 })).status).toBe(200);
  const saved = app.store.workspace(workspace.id);
  expect(saved.cloud.mode).toBe("manual");
  expect((await api(`/workspaces/${workspace.id}`, "PATCH", { version: saved.version, cloud: automatic })).status).toBe(409);
  const state = await (await api("/state")).json() as { startup: { enabled: boolean } };
  expect(state.startup.enabled).toBe(false);
});
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
it("authenticates workspace deletion, removes collected history and cancels future scheduling", async () => {
  const workspace = app.store.saveWorkspace({ path: root, providers: ["codex"] });
  app.store.markStarted(workspace.id);
  app.collector.schedule();
  expect(app.collector.nextAt).not.toBeNull();
  const file = join(root, "keep.txt");
  writeFileSync(file, "keep this source");
  app.store.db.prepare("INSERT INTO adit_history_sessions(provider,id,cwd,message_count,user_prompt_count,extra_json) VALUES('codex','keep-session',?,0,0,'{}')").run(root);
  const secrets = join(root, "state", "secrets");
  mkdirSync(secrets, { recursive: true });
  const credential = join(secrets, `${workspace.id}.${process.platform === "win32" ? "dpapi" : "keychain"}`);
  if (process.platform === "win32") writeFileSync(credential, "test-encrypted-placeholder");
  const endpoint = `/workspaces/${workspace.id}`;
  expect((await fetch(app.origin + "/api/local" + endpoint, { method: "DELETE" })).status).toBe(401);
  expect((await api(endpoint, "DELETE", { version: workspace.version + 1 })).status).toBe(409);
  app.store.job({ id: "active", workspaceId: workspace.id, kind: "collect", status: "running" });
  expect((await api(endpoint, "DELETE", { version: workspace.version })).status).toBe(409);
  app.store.job({ id: "active", workspaceId: workspace.id, kind: "collect", status: "done" });
  expect((await api(endpoint, "DELETE", { version: workspace.version })).status).toBe(200);
  expect(app.store.workspaces()).toEqual([]);
  expect(app.store.jobs()).toEqual([]);
  expect(app.collector.nextAt).toBeNull();
  expect(existsSync(file)).toBe(true);
  expect(existsSync(credential)).toBe(false);
  expect(app.store.db.prepare("SELECT id FROM adit_history_sessions WHERE id='keep-session'").get()).toBeUndefined();
  expect((await api(endpoint)).status).toBe(404);
  expect((await api(endpoint, "DELETE", { version: workspace.version })).status).toBe(404);
  expect((await api("/workspaces", "POST", { path: root })).status).toBe(201);
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
  await api("/startup", "PATCH", { enabled: true, version: 0 });
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
