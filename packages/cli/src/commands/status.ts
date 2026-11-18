import { join } from "node:path";
import Database from "better-sqlite3";
import {
  LocalStateError,
  localDataDir,
  resolveLocalProject,
  workspaceGitStatus,
  analyticsSessions,
  type LocalWorkspace,
} from "@varveai/adit-core";
import { daemonStatus } from "../local/daemon.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function validateWorkspace(workspace: LocalWorkspace): void {
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (
    !workspace ||
    [workspace.id, workspace.name, workspace.path].some(
      (value) => typeof value !== "string" || !value,
    ) ||
    typeof workspace.started !== "boolean" ||
    !strings(workspace.providers) ||
    !strings(workspace.repositories) ||
    !workspace.cloud ||
    typeof workspace.cloud.enabled !== "boolean" ||
    !["manual", "automatic"].includes(workspace.cloud.mode) ||
    !Number.isFinite(workspace.cloud.interval) ||
    workspace.cloud.interval <= 0
  ) {
    throw new Error(
      "Workspace record contains missing or invalid fields. Check the local workspace configuration.",
    );
  }
}

function workspaceStatus() {
  const project = resolveLocalProject();
  const storage = join(localDataDir(), "local.sqlite");
  const db = new Database(storage, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT data FROM adit_local_workspaces WHERE id=?")
      .get(project.projectId) as { data: string } | undefined;
    if (!row) throw new Error("Workspace disappeared while reading status. Try again.");
    const workspace = JSON.parse(row.data) as LocalWorkspace;
    validateWorkspace(workspace);
    const hasHistory = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='adit_history_sessions'")
      .get();
    return {
      projectId: workspace.id,
      name: workspace.name,
      path: workspace.path,
      storage,
      git: workspaceGitStatus(workspace.path),
      started: workspace.started,
      nativeSources: workspace.providers,
      sessions: hasHistory ? analyticsSessions(db, workspace).length : 0,
      cloud: workspace.cloud,
    };
  } finally {
    db.close();
  }
}

export async function statusCommand(opts?: { json?: boolean }): Promise<void> {
  let daemon: {
    state: "running" | "busy" | "stopped" | "error";
    url: string | null;
    port: number | null;
    pid: number | null;
    error?: string;
  };
  try {
    const instance = await daemonStatus({ reportErrors: true });
    daemon = instance
      ? {
          state: instance.busy ? "busy" : "running",
          url: instance.url,
          port: Number(new URL(instance.url).port),
          pid: instance.pid,
        }
      : { state: "stopped", url: null, port: null, pid: null };
  } catch (error) {
    daemon = { state: "error", url: null, port: null, pid: null, error: message(error) };
    process.exitCode = 1;
  }
  let workspace: ReturnType<typeof workspaceStatus> | undefined;
  let workspaceState: "initialized" | "uninitialized" | "error" = "initialized";
  let workspaceError: string | undefined;
  try {
    workspace = workspaceStatus();
  } catch (error) {
    if (error instanceof LocalStateError && error.status === 404) workspaceState = "uninitialized";
    else {
      workspaceState = "error";
      workspaceError = message(error);
      process.exitCode = 1;
    }
  }
  if (opts?.json) {
    console.log(
      JSON.stringify(
        {
          ...workspace,
          workspaceState,
          ...(workspaceError ? { error: workspaceError } : {}),
          backgroundRunning: daemon.state === "error" ? null : daemon.state !== "stopped",
          daemon,
        },
        null,
        2,
      ),
    );
    return;
  }
  const labels = { running: "Running", busy: "Running (busy)", stopped: "Stopped", error: "Error" };
  const lines = [`Service: ${labels[daemon.state]}`];
  if (daemon.url)
    lines.push(`Address: ${daemon.url}`, `Port: ${daemon.port}`, `PID: ${daemon.pid}`);
  if (daemon.error) lines.push(`Service error: ${daemon.error}`);
  if (workspace) {
    lines.push(
      `Workspace: ${workspace.name}`,
      `Project ID: ${workspace.projectId}`,
      `Path: ${workspace.path}`,
      `Storage: ${workspace.storage}`,
      `Git: ${workspace.git.available ? "Available" : (workspace.git.error ?? "Unavailable")}`,
      `Collection started: ${workspace.started ? "Yes" : "No"}`,
      `Sources: ${workspace.nativeSources.join(", ") || "None"}`,
      `Sessions: ${workspace.sessions}`,
      `Cloud: ${workspace.cloud.enabled ? "Enabled" : "Disabled"} (${workspace.cloud.mode}, interval ${workspace.cloud.interval} minutes)`,
    );
  } else if (workspaceState === "uninitialized") {
    lines.push(
      "Workspace: Current directory is not initialized. Run adit init or add it in Settings.",
    );
  } else lines.push(`Workspace error: ${workspaceError}`);
  console.log(lines.join("\n"));
}
