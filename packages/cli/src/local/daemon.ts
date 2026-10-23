import { spawn } from "node:child_process";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { localDataDir, LocalStore } from "@varveai/adit-core";
import { startLocalServer } from "./server.js";

interface Instance {
  pid: number;
  url: string;
  token: string;
  instance: string;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function readInstance(): Instance | null {
  try {
    return JSON.parse(
      readFileSync(join(localDataDir(), "daemon.json"), "utf8"),
    );
  } catch {
    return null;
  }
}
export async function daemonStatus(): Promise<Instance | null> {
  const info = readInstance();
  if (!info) return null;
  try {
    const health = (await fetch(`${info.url}/health`, {
      signal: AbortSignal.timeout(1500),
    }).then((r) => r.json())) as { service: string; instance: string };
    return health.service === "adit-local" && health.instance === info.instance
      ? info
      : null;
  } catch {
    return null;
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export async function runDaemon(port?: number): Promise<void> {
  const dir = localDataDir();
  mkdirSync(dir, { recursive: true });
  const instance = randomBytes(16).toString("hex");
  const lockStore = new LocalStore(dir);
  const preferredPort = lockStore.get<number | undefined>("daemon-port", undefined);
  try {
    lockStore.db.transaction(() => {
      const current = lockStore.get<{pid: number; instance: string} | null>("daemon-lock", null);
      if (current && alive(current.pid)) throw new Error("A local daemon is already starting or running");
      lockStore.set("daemon-lock", { pid: process.pid, instance });
    }).immediate();
  } finally { lockStore.close(); }
  const releaseLock = () => {
    const store = new LocalStore(dir);
    try {
      store.db.transaction(() => {
        const current = store.get<{instance: string} | null>("daemon-lock", null);
        if (current?.instance === instance) store.db.prepare("DELETE FROM adit_local_settings WHERE key='daemon-lock'").run();
      }).immediate();
    } finally { store.close(); }
  };
  const token = randomBytes(32).toString("hex");
  try {
    const requestedPort = port ?? preferredPort;
    const app = await startLocalServer({ port: requestedPort, token, instance }).catch(async (error: NodeJS.ErrnoException) => {
      // Reuse the previous address after login/restart. If another app now owns
      // that port, choose an available port; an explicitly requested port still fails.
      if (port === undefined && preferredPort && error.code === "EADDRINUSE")
        return startLocalServer({ token, instance });
      throw error;
    });
    const settings = new LocalStore(dir);
    try { settings.set("daemon-port", Number(new URL(app.origin).port)); }
    finally { settings.close(); }
    writeFileSync(
      join(dir, "daemon.json"),
      JSON.stringify({
        pid: process.pid,
        url: app.origin,
        token,
        instance: app.instance,
      }),
      { mode: 0o600 },
    );
    const cleanup = () => {
      try {
        releaseLock();
      } catch {}
      try {
        if (readInstance()?.pid === process.pid)
          unlinkSync(join(dir, "daemon.json"));
      } catch {}
    };
    app.server.on("close", () => {
      cleanup();
      process.exitCode = 0;
    });
    process.once("SIGTERM", () => void app.close());
    process.once("SIGINT", () => void app.close());
    process.once("exit", cleanup);
  } catch (e) {
    try {
      releaseLock();
    } catch {}
    throw e;
  }
}
export async function startDaemon(port?: number): Promise<Instance> {
  const current = await daemonStatus();
  if (current) return current;
  const dir = localDataDir();
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, "daemon.log"), "a", 0o600);
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [worker, ...(port ? [String(port)] : [])],
    {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ADIT_CLI_ENTRY: process.env.ADIT_CLI_ENTRY ||
          (process.argv[1] && basename(process.argv[1]) === "index.js"
            ? resolve(process.argv[1]) : fileURLToPath(new URL("../index.js", import.meta.url))),
      },
    },
  );
  let startupError: Error | undefined;
  child.on("error", (error) => {
    startupError = error;
  });
  child.unref();
  closeSync(log);
  for (let i = 0; i < 60; i++) {
    await delay(250);
    if (startupError) throw startupError;
    const info = await daemonStatus();
    if (info) return info;
  }
  throw new Error(
    `Local daemon did not start. Inspect ${join(dir, "daemon.log")}`,
  );
}
export async function stopDaemon(): Promise<void> {
  const current = await daemonStatus();
  if (!current) return;
  await fetch(`${current.url}/api/local/stop`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${current.token}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  for (let i = 0; i < 80; i++) {
    if (!(await daemonStatus())) return;
    await delay(250);
  }
  throw new Error("Daemon is still shutting down");
}
export function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? "rundll32.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}
export async function serveCommand(options: {
  port?: string;
  browser?: boolean;
}): Promise<void> {
  const port = options.port ? Number(options.port) : undefined;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new Error("Invalid port");
  const daemon = await startDaemon(port);
  console.log(daemon.url);
  if (options.browser !== false)
    openBrowser(daemon.url);
}
