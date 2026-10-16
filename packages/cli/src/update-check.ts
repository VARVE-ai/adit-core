import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadCredentials } from "@varveai/adit-cloud";
import pc from "picocolors";
import { outputStyle, setPendingNotice, takePendingNotice } from "./commands/cli-style.js";
import { CLI_VERSION } from "./version.js";

const UPDATE_CHECK_TTL_MS = 10 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 1500;
const NPM_LATEST_URL =
  "https://registry.npmjs.org/@varveai%2fadit-cli/latest";
const DEFAULT_VERSION_POLICY_URL =
  "https://adit-cloud.varve.ai/api/client-version-policy";
const DEFAULT_UPGRADE_COMMAND = "npm install -g @varveai/adit-cli@latest";

/** Commands that check the cloud version policy (a blocked version must not run them). */
export const UPDATE_CHECK_COMMANDS = new Set([
  "init",
  "status",
  "doctor",
  "hook.install",
  "hook.validate",
  "cloud.login",
  "cloud.status",
  "cloud.sync",
  "cloud.link",
  "cloud.claude",
  "cloud.codex",
]);

/** Commands that also show the "update available" notice, above their closing line. */
export const UPDATE_NOTICE_COMMANDS = new Set(["init", "status", "doctor"]);

interface VersionCheckCache {
  checkedAt?: number;
  latestVersion?: string;
}

export interface VersionPolicyDecision {
  decision: "ok" | "block";
  currentVersion: string;
}

interface FetchLikeResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

type FetchLike = (
  input: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

interface WritableLike {
  isTTY?: boolean;
  write(text: string): unknown;
}

export interface UpdateCheckOptions {
  commandId: string;
  currentVersion?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  json?: boolean;
  now?: number;
  stderr?: WritableLike;
  cachePath?: string;
  cloudServerUrl?: string | null;
  /** Receives the update notice instead of stderr (the caller shows it later). */
  onNotice?: (notice: string) => void;
}

interface UpdateWarningWrapperOptions<T extends unknown[]> {
  json?: boolean | ((...args: T) => boolean);
}

export function withUpdateWarning<T extends unknown[]>(
  commandId: string,
  handler: (...args: T) => Promise<void> | void,
  options: UpdateWarningWrapperOptions<T> = {},
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    const json =
      typeof options.json === "function"
        ? options.json(...args)
        : (options.json ?? inferJsonOption(args));

    const blocked = await maybeWarnForUpdate({
      commandId,
      cloudServerUrl: loadCredentials()?.serverUrl ?? null,
      env: process.env,
      json,
      stderr: process.stderr,
      onNotice: setPendingNotice,
    });
    if (blocked) {
      process.exitCode = 1;
      return;
    }

    try {
      return await handler(...args);
    } finally {
      // Commands that print a closing line show the notice above it; any
      // other output path (JSON, early returns) gets it as the last line.
      const notice = takePendingNotice();
      if (notice) process.stderr.write(`${notice}\n`);
    }
  };
}

export async function maybeWarnForUpdate(
  options: UpdateCheckOptions,
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!UPDATE_CHECK_COMMANDS.has(options.commandId)) return false;

  const currentVersion = options.currentVersion ?? CLI_VERSION;
  const cachePath = options.cachePath ?? getVersionCheckCachePath();
  const now = options.now ?? Date.now();

  const policy = await getVersionPolicyDecision({
    currentVersion,
    cloudServerUrl: options.cloudServerUrl,
    env,
    fetchImpl: options.fetchImpl ?? fetch,
  });

  if (policy?.decision === "block") {
    const stderr = options.stderr ?? process.stderr;
    stderr.write(
      formatCriticalUpdateBlock(
        policy,
        shouldColorUpdateWarning(stderr, options.json ?? false),
      ),
    );
    return true;
  }

  if (!UPDATE_NOTICE_COMMANDS.has(options.commandId)) return false;
  if (isUpdateCheckDisabled(env)) return false;
  if (isCi(env)) return false;

  const latestVersion = await getLatestVersion({
    cachePath,
    currentVersion,
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    now,
  });

  if (!latestVersion) return false;
  if (compareVersions(currentVersion, latestVersion) >= 0) return false;

  const stderr = options.stderr ?? process.stderr;
  const notice = formatUpdateWarning(
    currentVersion,
    latestVersion,
    shouldColorUpdateWarning(stderr, options.json ?? false),
  );
  if (options.onNotice) options.onNotice(notice);
  else stderr.write(`${notice}\n`);
  return false;
}

export function getVersionCheckCachePath(): string {
  return join(homedir(), ".adit", "version-check.json");
}

/** One line: "! Update available 1.0.0 → 1.2.0 · run adit update". */
export function formatUpdateWarning(
  currentVersion: string,
  latestVersion: string,
  color = false,
): string {
  const colors = pc.createColors(color);
  const unicode = outputStyle().unicode;
  const mark = colors.yellow(unicode ? "!" : "[!]");
  const arrow = unicode ? "→" : "->";
  return `${mark} ${colors.dim(`Update available ${currentVersion} ${arrow} ${latestVersion} · run`)} ${colors.bold("adit update")}`;
}

/** The blocked-version failure, in the shared error shape. */
export function formatCriticalUpdateBlock(
  policy: VersionPolicyDecision,
  color = false,
): string {
  const colors = pc.createColors(color);
  const mark = colors.red(outputStyle().unicode ? "✗" : "[x]");
  return [
    `${mark} ADIT update required: version ${policy.currentVersion} is blocked by adit-cloud policy`,
    `  ${colors.dim(`run ${colors.bold(DEFAULT_UPGRADE_COMMAND)}`)}`,
  ].join("\n") + "\n";
}

export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) return 0;

  for (let i = 0; i < 3; i += 1) {
    const diff = parsedA.core[i] - parsedB.core[i];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  if (parsedA.prerelease === parsedB.prerelease) return 0;
  if (!parsedA.prerelease) return 1;
  if (!parsedB.prerelease) return -1;
  return parsedA.prerelease.localeCompare(parsedB.prerelease);
}

function inferJsonOption(args: readonly unknown[]): boolean {
  const maybeOptions = args[args.length - 1];
  if (!maybeOptions || typeof maybeOptions !== "object") return false;
  return Boolean((maybeOptions as { json?: unknown }).json);
}

function isUpdateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ADIT_NO_UPDATE_CHECK;
  return value === "1" || value === "true";
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI && env.CI !== "false");
}

function shouldColorUpdateWarning(stderr: WritableLike, json: boolean): boolean {
  return !json && Boolean(stderr.isTTY);
}

async function getLatestVersion(options: {
  cachePath: string;
  currentVersion: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now: number;
}): Promise<string | null> {
  const cached = readFreshCache(options.cachePath, options.now);
  if (cached?.latestVersion) return cached.latestVersion;

  try {
    const latestVersion = await fetchLatestVersion(
      options.fetchImpl,
      options.currentVersion,
      options.env,
    );
    writeCache(options.cachePath, {
      ...(readCache(options.cachePath) ?? {}),
      checkedAt: options.now,
      latestVersion,
    });
    return latestVersion;
  } catch {
    return null;
  }
}

async function getVersionPolicyDecision(options: {
  currentVersion: string;
  cloudServerUrl?: string | null;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
}): Promise<VersionPolicyDecision | null> {
  const policyUrl = getVersionPolicyUrl(options.env, options.cloudServerUrl);

  try {
    return await fetchVersionPolicy(
      options.fetchImpl,
      options.currentVersion,
      policyUrl,
    );
  } catch {
    return null;
  }
}

/**
 * Latest version published to npm, bypassing the local cache. Used by
 * `adit update`, which is explicit and can afford a longer timeout than the
 * passive post-command check. Returns null when the registry is unreachable.
 */
export async function fetchLatestPublishedVersion(options: {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<string | null> {
  try {
    return await fetchLatestVersion(
      options.fetchImpl ?? (fetch as unknown as FetchLike),
      CLI_VERSION,
      options.env ?? process.env,
      options.timeoutMs ?? 8000,
    );
  } catch {
    return null;
  }
}

async function fetchLatestVersion(
  fetchImpl: FetchLike,
  currentVersion: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(env.ADIT_UPDATE_CHECK_URL ?? NPM_LATEST_URL, {
      headers: {
        accept: "application/json",
        "user-agent": `adit-cli/${currentVersion}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Version check failed");

    const data = responseDataToRecord(await response.json());
    const latestVersion = data.version ?? data.latestVersion;
    if (typeof latestVersion !== "string" || !parseVersion(latestVersion)) {
      throw new Error("Version check response did not include a valid version");
    }
    return latestVersion;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchVersionPolicy(
  fetchImpl: FetchLike,
  currentVersion: string,
  policyUrl: string,
): Promise<VersionPolicyDecision> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    const url = new URL(policyUrl);
    url.searchParams.set("version", currentVersion);
    const response = await fetchImpl(url.toString(), {
      headers: {
        accept: "application/json",
        "user-agent": `adit-cli/${currentVersion}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Version policy check failed");

    const data = responseDataToRecord(await response.json());
    return responseDataToPolicyDecision(data, currentVersion);
  } finally {
    clearTimeout(timeout);
  }
}

function getVersionPolicyUrl(
  env: NodeJS.ProcessEnv,
  cloudServerUrl?: string | null,
): string {
  const serverUrl = env.ADIT_CLOUD_URL?.trim() || cloudServerUrl?.trim();
  if (serverUrl) {
    return `${serverUrl.replace(/\/$/, "")}/api/client-version-policy`;
  }

  return DEFAULT_VERSION_POLICY_URL;
}

function readFreshCache(
  cachePath: string,
  now: number,
): VersionCheckCache | null {
  const cache = readCache(cachePath);
  if (!cache) return null;
  if (typeof cache.checkedAt !== "number") return null;
  if (now - cache.checkedAt > UPDATE_CHECK_TTL_MS) return null;
  if (!cache.latestVersion) return null;
  return cache;
}

function readCache(cachePath: string): VersionCheckCache | null {
  if (!existsSync(cachePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      checkedAt?: unknown;
      latestVersion?: unknown;
    };
    const cache: VersionCheckCache = {};
    if (
      typeof parsed.checkedAt === "number" &&
      typeof parsed.latestVersion === "string" &&
      parseVersion(parsed.latestVersion)
    ) {
      cache.checkedAt = parsed.checkedAt;
      cache.latestVersion = parsed.latestVersion;
    }

    return cache.latestVersion ? cache : null;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, cache: VersionCheckCache): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // Best effort only; update checks must never break the command.
  }
}

function responseDataToRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

function responseDataToPolicyDecision(
  data: Record<string, unknown>,
  fallbackCurrentVersion: string,
): VersionPolicyDecision {
  const decision = responseDataToPolicyDecisionOrNull(data, fallbackCurrentVersion);
  if (!decision) {
    throw new Error("Version policy response did not include a valid decision");
  }
  return decision;
}

function responseDataToPolicyDecisionOrNull(
  data: unknown,
  fallbackCurrentVersion: string,
): VersionPolicyDecision | null {
  const record = responseDataToRecord(data);
  const decision = record.decision;
  if (decision !== "ok" && decision !== "block") return null;

  const currentVersion =
    typeof record.currentVersion === "string" && parseVersion(record.currentVersion)
      ? record.currentVersion
      : fallbackCurrentVersion;
  if (!parseVersion(currentVersion)) return null;

  return {
    decision,
    currentVersion,
  };
}

function parseVersion(
  version: string,
): { core: [number, number, number]; prerelease: string } | null {
  const match = version
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;

  return {
    core: [
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
      Number.parseInt(match[3], 10),
    ],
    prerelease: match[4] ?? "",
  };
}
