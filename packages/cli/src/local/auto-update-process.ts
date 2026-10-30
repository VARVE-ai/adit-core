import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type UpdateManager = "npm" | "pnpm" | "yarn" | "bun";
export type UpdateInstallation = { entry: string; root: string; manager: UpdateManager };
export type UpdateRequest = {
  id: string;
  version: string;
  installation: UpdateInstallation;
  directory: string;
  resultPath: string;
};
export type UpdateResult = { id: string; version: string; finishedAt: number; error?: string };

export function updateEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...environment };
  const key =
    Object.keys(env).find((name) =>
      process.platform === "win32" ? name.toLowerCase() === "path" : name === "PATH",
    ) ?? "PATH";
  env[key] = `${dirname(process.execPath)}${delimiter}${env[key] ?? ""}`;
  return env;
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function installationLockPath(
  root: string,
  directory = join(homedir(), ".adit", "update-locks"),
): string {
  const normalized = resolve(root);
  const key = createHash("sha256")
    .update(process.platform === "win32" ? normalized.toLowerCase() : normalized)
    .digest("hex");
  return join(directory, `${key}.json`);
}

export function acquireInstallationLock(root: string, directory?: string): () => void {
  const path = installationLockPath(root, directory);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      const owner = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
      if (!processAlive(owner.pid)) unlinkSync(path);
    } catch {}
  }
  const id = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    throw new Error("Another ADIT update is in progress. Try again later.");
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, id }));
  } finally {
    closeSync(descriptor);
  }
  return () => {
    try {
      if (JSON.parse(readFileSync(path, "utf8")).id === id) unlinkSync(path);
    } catch {}
  };
}

export function updateCommand(manager: UpdateManager, version: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Automatic updates require a stable release");
  const commands = {
    npm: "npm install -g",
    pnpm: "pnpm add -g",
    yarn: "yarn global add",
    bun: "bun add -g",
  };
  if (!Object.hasOwn(commands, manager)) throw new Error("Unsupported package manager");
  return `${commands[manager]} @varveai/adit-cli@${version}`;
}

export function runUpdateCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  directory: string,
): Promise<void> {
  return new Promise((resolveDone, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env,
      windowsHide: true,
      stdio: ["ignore", "inherit", "pipe"],
      detached: process.platform !== "win32",
    });
    let errorTail = "";
    child.stderr.on("data", (chunk) => {
      errorTail = (errorTail + String(chunk)).slice(-8192);
      process.stderr.write(chunk);
    });
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.once("error", () => child.kill());
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      },
      10 * 60 * 1000,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (timedOut)
        reject(
          new Error(
            "Automatic update timed out. See auto-update.log; run 'adit update' to retry manually.",
          ),
        );
      else if (code === 0) resolveDone();
      else {
        const errorCode = /(?:npm error code |npm ERR! code |\b)(E[A-Z_0-9]{2,80})\b/.exec(
          errorTail,
        )?.[1];
        reject(
          new Error(
            `Update command failed${errorCode ? `: ${errorCode}` : ""} (exit ${code ?? "signal"}). See auto-update.log; run 'adit update' to retry manually.`,
          ),
        );
      }
    });
  });
}

export async function performAutomaticUpdate(
  request: UpdateRequest,
  run = runUpdateCommand,
  lockDirectory?: string,
): Promise<void> {
  const command = updateCommand(request.installation.manager, request.version);
  const release = acquireInstallationLock(request.installation.root, lockDirectory);
  try {
    const env: NodeJS.ProcessEnv = {
      ...updateEnvironment(),
      ADIT_LOCAL_DATA_DIR: request.directory,
      ADIT_CLI_ENTRY: request.installation.entry,
      ADIT_DEFER_INSTALL_SETUP: "1",
    };
    delete env.ADIT_UPGRADE_COMMAND;
    if (process.platform === "win32")
      await run(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", command],
        env,
        request.directory,
      );
    else {
      const [program, ...args] = command.split(" ");
      await run(program, args, env, request.directory);
    }
    delete env.ADIT_DEFER_INSTALL_SETUP;
    await run(
      process.execPath,
      [
        join(dirname(request.installation.entry), "install-skills.js"),
        "--expected-version",
        request.version,
      ],
      env,
      request.directory,
    );
  } finally {
    release();
  }
}

async function main() {
  const request = JSON.parse(readFileSync(process.argv[2], "utf8")) as UpdateRequest;
  const result: UpdateResult = { id: request.id, version: request.version, finishedAt: Date.now() };
  try {
    await performAutomaticUpdate(request);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(result.error);
    process.exitCode = 1;
  }
  result.finishedAt = Date.now();
  const temporary = `${request.resultPath}.${request.id}.tmp`;
  writeFileSync(temporary, JSON.stringify(result), { mode: 0o600 });
  renameSync(temporary, request.resultPath);
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
