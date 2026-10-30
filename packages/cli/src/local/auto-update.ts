import { LocalStateError, type LocalStore } from "@varveai/adit-core";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_VERSION } from "../version.js";
import { compareVersions, fetchLatestPublishedVersion } from "../update-check.js";
import {
  detectAutomaticInstallation,
  type InstallationDetection,
} from "./auto-update-installation.js";
import { processAlive, type UpdateRequest, type UpdateResult } from "./auto-update-process.js";

const day = 24 * 60 * 60 * 1000;
type UpdatePhase =
  "idle" | "checking" | "current" | "waiting" | "installing" | "updated" | "failed";
type SavedUpdate = {
  enabled: boolean;
  version: number;
  phase: UpdatePhase;
  lastCheckedAt?: number;
  nextCheckAt?: number;
  latestVersion?: string;
  updatedAt?: number;
  updatedVersion?: string;
  error?: string;
  failures?: number;
  requestId?: string;
  pid?: number;
};
export type AutomaticUpdateStatus = SavedUpdate & {
  supported: boolean;
  reason?: InstallationDetection["reason"] | "detecting";
};
type UpdateOptions = {
  detect?: () => Promise<InstallationDetection>;
  latest?: () => Promise<string | null>;
  launch?: (request: UpdateRequest) => Promise<number>;
  now?: () => number;
  currentVersion?: string;
  acquire: () => (() => void) | undefined;
};

export async function launchAutomaticUpdate(request: UpdateRequest): Promise<number> {
  const directory = join(request.directory, "auto-update");
  mkdirSync(directory, { recursive: true });
  const script = join(directory, "updater.mjs");
  copyFileSync(new URL("./auto-update-process.js", import.meta.url), script);
  const config = join(directory, "request.json");
  writeFileSync(config, JSON.stringify(request), { mode: 0o600 });
  const log = openSync(join(request.directory, "auto-update.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [script, config], {
      cwd: request.directory,
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    await new Promise<void>((resolveStarted, reject) => {
      child.once("error", reject);
      child.once("spawn", resolveStarted);
    });
    child.unref();
    return child.pid!;
  } finally {
    closeSync(log);
  }
}

export class AutomaticUpdate {
  private saved: SavedUpdate;
  private detection: InstallationDetection = {};
  private initialized = false;
  private initializing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  private release?: () => void;
  private readonly now: () => number;

  constructor(
    private store: LocalStore,
    private options: UpdateOptions,
  ) {
    this.saved = store.get<SavedUpdate>("automatic-update", {
      enabled: true,
      version: 0,
      phase: "idle",
    });
    this.now = options.now ?? Date.now;
  }

  status(): AutomaticUpdateStatus {
    const { pid: _pid, requestId: _requestId, ...saved } = this.saved;
    return {
      ...saved,
      supported: !!this.detection.installation,
      reason: this.initialized ? this.detection.reason : "detecting",
    };
  }

  get updating() {
    return !!this.release;
  }

  initialize(): Promise<void> {
    return (this.initializing ??= (async () => {
      try {
        this.detection = await (this.options.detect ?? detectAutomaticInstallation)();
      } catch {
        this.detection = { reason: "unknown" };
      }
      this.initialized = true;
      if (this.saved.phase === "checking")
        this.persist({ phase: "idle", nextCheckAt: this.now() + 60_000 });
    })());
  }

  save(input: Record<string, unknown>): AutomaticUpdateStatus {
    if (typeof input.enabled !== "boolean" || !Number.isInteger(input.version))
      throw new LocalStateError("Invalid automatic update settings");
    if (input.version !== this.saved.version)
      throw new LocalStateError("Automatic update settings changed. Refresh and try again.", 409);
    if (this.saved.phase === "installing")
      throw new LocalStateError("ADIT is updating. Please wait before changing this setting.", 409);
    if (input.enabled && !this.detection.installation)
      throw new LocalStateError("Automatic updates are unavailable for this installation", 409);
    this.persist({ enabled: input.enabled, version: this.saved.version + 1 });
    return this.status();
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 5000);
    this.timer.unref();
    void this.initialize().catch(() => {});
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.running ??= this.run().finally(() => {
      this.running = undefined;
    }));
  }

  private persist(next: Partial<SavedUpdate>) {
    this.saved = { ...this.saved, ...next };
    this.store.set("automatic-update", this.saved);
  }

  private fail(error: string) {
    const failures = (this.saved.failures ?? 0) + 1;
    this.persist({
      phase: "failed",
      error,
      failures,
      pid: undefined,
      requestId: undefined,
      nextCheckAt: this.now() + Math.min(24, 2 ** Math.min(failures - 1, 5)) * 60 * 60 * 1000,
    });
    this.release?.();
    this.release = undefined;
  }

  private async run() {
    await this.initialize();
    if (this.stopped) return;
    const resultPath = join(this.store.directory, "auto-update", "result.json");
    if (this.saved.phase === "installing") {
      let result: UpdateResult | undefined;
      try {
        result = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch {}
      if (result && result.id === this.saved.requestId) {
        if (result.error) this.fail(result.error);
        else {
          this.persist({
            phase: "updated",
            updatedAt: result.finishedAt,
            updatedVersion: result.version,
            nextCheckAt: this.now() + day,
            failures: 0,
            error: undefined,
            requestId: undefined,
            pid: undefined,
          });
          this.release?.();
          this.release = undefined;
        }
      } else if (!this.saved.pid || !processAlive(this.saved.pid))
        this.fail("Automatic update was interrupted. Run 'adit update' to retry manually.");
      return;
    }
    const installation = this.detection.installation;
    if (!installation || !this.saved.enabled) return;
    if (!this.saved.nextCheckAt || this.now() >= this.saved.nextCheckAt) {
      this.persist({
        phase: "checking",
        lastCheckedAt: this.now(),
        nextCheckAt: this.now() + day,
        error: undefined,
      });
      let latest: string | null;
      try {
        latest = await (this.options.latest ?? (() => fetchLatestPublishedVersion({ env: {} })))();
      } catch {
        latest = null;
      }
      if (this.stopped) return;
      if (!latest || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(latest)) {
        this.fail("Could not check the latest stable release. Will retry later.");
        return;
      }
      this.persist({
        latestVersion: latest,
        phase:
          compareVersions(this.options.currentVersion ?? CLI_VERSION, latest) < 0
            ? "waiting"
            : "current",
        failures:
          compareVersions(this.options.currentVersion ?? CLI_VERSION, latest) < 0
            ? this.saved.failures
            : 0,
      });
    }
    if (!this.saved.enabled || this.saved.phase !== "waiting") return;
    const release = this.options.acquire();
    if (!release) return;
    this.release = release;
    const id = randomUUID();
    this.persist({ phase: "installing", requestId: id, error: undefined });
    try {
      const pid = await (this.options.launch ?? launchAutomaticUpdate)({
        id,
        version: this.saved.latestVersion!,
        installation,
        directory: this.store.directory,
        resultPath,
      });
      this.persist({ pid });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.initializing;
    await this.running;
  }
}
