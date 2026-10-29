import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { LocalStore } from "@varveai/adit-core";
import { UserLoginRegistration, LoginStartup } from "./login-startup.js";
import { createServer } from "node:net";

const exec = promisify(execFile);
it("keeps one detached instance and resumes collection after restart without a browser", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-daemon-test-"));
  const data = join(root, "data"),
    workspace = join(root, "workspace"),
    source = join(root, "source");
  // This lifecycle fixture exercises an explicitly disabled global preference.
  // Never create a login entry in the developer's actual OS Startup directory.
  const initialSettings = new LocalStore(data);
  initialSettings.set("login-startup", { enabled: false, version: 1 });
  initialSettings.close();
  await exec("git", ["init", workspace], { windowsHide: true });
  await exec("git", ["-C", workspace, "remote", "add", "origin", "https://example.invalid/test.git"], { windowsHide: true });
  await exec("git", ["-C", workspace, "config", "user.email", "fixture@example.test"], { windowsHide: true });
  mkdirSync(source);
  const env = {
    ...process.env,
    ADIT_LOCAL_DATA_DIR: data,
    CODEX_SESSIONS_DIR: source,
    CLAUDE_PROJECTS_DIR: join(root, "absent"),
    GEMINI_DIR: join(root, "absent"),
    DEEPSEEK_TUI_SESSIONS_DIR: join(root, "absent"),
  };
  const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
  const cli = (...args: string[]) =>
    exec(process.execPath, [entry, ...args], {
      env,
      windowsHide: true,
      timeout: 20000,
    });
  const info = () =>
    JSON.parse(readFileSync(join(data, "daemon.json"), "utf8")) as {
      url: string;
      token: string;
      pid: number;
    };
  const api = (path: string, method = "GET", body?: unknown) => {
    const current = info();
    return fetch(current.url + "/api/local" + path, {
      method,
      headers: {
        authorization: `Bearer ${current.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  const waitForDone = async () => {
    for (let i = 0; i < 150; i++) {
      const state = (await (await api("/state")).json()) as {
        jobs: { status: string }[];
      };
      if (state.jobs[0]?.status === "done") return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("Collection did not finish");
  };
  const log = join(source, "rollout-example.jsonl");
  writeFileSync(
    log,
    [
      { type: "session_meta", payload: { id: "detached", cwd: workspace } },
      { type: "turn_context", payload: { model: "example-model" } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: "first" },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  try {
    await cli("daemon", "start", "--on-login");
    expect((await cli("daemon", "status")).stdout.trim()).toBe("Stopped");
    const started = await Promise.all([
      cli("server", "--no-browser"),
      cli("serve", "--no-browser"),
    ]);
    expect(started[0].stdout.trim()).toBe(started[1].stdout.trim());
    const originalPid = info().pid;
    expect((await cli("daemon", "status")).stdout).toContain("Running:");
    await cli("daemon", "start");
    expect(info().pid).toBe(originalPid);
    const response = await api("/workspaces", "POST", {
      path: workspace,
      providers: ["codex"],
      repositories: [workspace],
    });
    expect(response.status).toBe(201);
    const w = (await response.json()) as { id: string };
    await api(`/workspaces/${w.id}/collect`, "POST", {});
    await waitForDone();
    await cli("daemon", "stop");
    expect((await cli("daemon", "status")).stdout.trim()).toBe("Stopped");
    appendFileSync(
      log,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: "after restart",
        },
      }) + "\n",
    );
    await cli("daemon", "start");
    expect(info().url).toBe(started[0].stdout.trim());
    let resumed = false;
    expect(
      (
        await fetch(info().url + "/api/local/state", {
          headers: { "x-adit-local": "1" },
        })
      ).status,
    ).toBe(200);
    for (let i = 0; i < 150; i++) {
      const db = new Database(join(data, "local.sqlite"), { readonly: true });
      const messages = db
        .prepare(
          "SELECT model FROM adit_history_messages WHERE session_id='detached' ORDER BY ordinal",
        )
        .all() as { model: string }[];
      db.close();
      if (messages.length === 2) {
        expect(messages[1].model).toBe("example-model");
        resumed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(resumed).toBe(true);
    await waitForDone();
    await cli("daemon", "stop");
    const settings = new LocalStore(data);
    settings.saveSchedule({ ...settings.schedule(), enabled: false });
    // An unfinished attribution setup must still wait for an explicit collection.
    settings.db.prepare("DELETE FROM adit_attribution_runs").run();
    const jobsBefore = settings.jobs().length;
    settings.close();
    await cli("daemon", "start");
    await new Promise((r) => setTimeout(r, 1500));
    expect((await api(`/commits?workspaceId=${w.id}`)).status).toBe(200);
    const stopped = new LocalStore(data);
    try {
      expect(stopped.jobs()).toHaveLength(jobsBefore);
      expect(
        stopped.db
          .prepare("SELECT count(*) n FROM adit_attribution_runs")
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      stopped.close();
    }
  } finally {
    await cli("daemon", "stop");
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

it("runs the login launcher only with consent and falls back safely if the previous port is occupied", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-login-daemon-"));
  const data = join(root, "用户's local data");
  const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
  const env = { ...process.env, ADIT_LOCAL_DATA_DIR: data };
  const cli = (...args: string[]) => exec(process.execPath, [entry, ...args], { cwd: root, env, windowsHide: true, timeout: 20000 });
  const settings = new LocalStore(data);
  const registration = new UserLoginRegistration(data, { entry, appData: root, home: root, configHome: join(root, "config") });
  const startup = new LoginStartup(settings, registration);
  const occupied = createServer();
  try {
    await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
    const port = (occupied.address() as { port: number }).port;
    settings.set("daemon-port", port);
    await startup.save({ enabled: true, version: 0 });
    const launch = () => exec(process.execPath, [join(data, "startup", "start.cjs")], { cwd: root, env, windowsHide: true, timeout: 25000 });
    await launch();
    const info = JSON.parse(readFileSync(join(data, "daemon.json"), "utf8")) as { url: string; pid: number };
    expect(new URL(info.url).port).not.toBe(String(port));
    expect((await cli("daemon", "status")).stdout).toContain("Running:");
    await launch();
    expect(JSON.parse(readFileSync(join(data, "daemon.json"), "utf8")).pid).toBe(info.pid);
    await startup.save({ enabled: false, version: 1 });
    expect((await cli("daemon", "status")).stdout).toContain("Running:");
    await cli("daemon", "stop");
    await launch();
    expect((await cli("daemon", "status")).stdout.trim()).toBe("Stopped");
  } finally {
    await cli("daemon", "stop");
    await registration.remove();
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    settings.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 45000);
