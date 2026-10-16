/**
 * CLI handler for `adit cloud link`.
 *
 * These wire up the config/credentials/database lifecycle around the
 * command handlers from @varveai/adit-cloud/project-link.
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  openDatabase,
  closeDatabase,
  type AditConfig,
} from "@varveai/adit-core";
import {
  loadCloudConfig,
  loadCredentials,
  CloudClient,
  CloudAuthError,
  CloudNetworkError,
  CloudApiError,
  WorkspaceLinkPartialFailureError,
  linkCommand,
  DEFAULT_SERVER_URL,
  CloudProjectDeletedError,
  refreshProjectDeletionPolicy,
} from "@varveai/adit-cloud";
import type {
  LinkOptions,
  LinkResult,
  ProjectDeletionPolicy,
} from "@varveai/adit-cloud";
import { getRemoteUrl } from "@varveai/adit-engine";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import {
  dim,
  displayWidth,
  formatCount,
  formatDuration,
  joinParts,
  marks,
  padEnd,
  plural,
  printEnd,
  printError,
  printLine,
  printTitle,
  printTransient,
  shortId,
  stateWord,
  strong,
  truncate,
} from "./cli-style.js";

interface RepositoryPrecheckIssue {
  label: string;
  problem: "missing" | "no-origin";
}

/**
 * Validate every manifest repository locally — existence and origin — so all
 * problems are reported at once, before any authentication or network call.
 */
async function precheckManifestRepositories(config: AditConfig): Promise<RepositoryPrecheckIssue[]> {
  const issues: RepositoryPrecheckIssue[] = [];
  for (const repository of config.repositories) {
    const label = repository.relativePath === "." ? repository.displayName : repository.relativePath;
    if (!existsSync(join(repository.path, ".git"))) {
      issues.push({ label, problem: "missing" });
      continue;
    }
    const remoteUrl = await getRemoteUrl(repository.path).catch(() => null);
    if (!remoteUrl) {
      issues.push({ label, problem: "no-origin" });
    }
  }
  return issues;
}

function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl;
  }
}

/** The step and root cause behind a failure; silent link runs wrap causes with the failing step. */
function unwrapLinkError(error: unknown): { step: string | null; cause: unknown } {
  if (error && typeof error === "object" && "step" in error && "cause" in error && typeof (error as { step: unknown }).step === "string") {
    return { step: (error as { step: string }).step, cause: (error as { cause: unknown }).cause };
  }
  return { step: null, cause: error };
}

/**
 * `adit cloud link` — Link this project to adit-cloud.
 *
 * Returns the link result on success so callers embedding the link flow
 * (adit init) can render their own summary; null on any failure. Text mode
 * renders one row per repository as each finishes; `silent` (adit init)
 * prints nothing but failures, as rows inside the caller's block.
 */
export async function projectLinkCliHandler(opts: LinkOptions): Promise<LinkResult | null> {
  let config = loadInitializedProjectConfig("adit cloud link");
  if (!config) return null;
  const text = !opts.json && !opts.silent;
  const fail = (reason: string, hint?: string) => {
    if (opts.silent) printLine(`${marks.fail} ${reason}${hint ? dim(` · ${hint}`) : ""}`, { stream: "stderr" });
    else printError("link", reason, hint);
    process.exitCode = 1;
  };

  // Prerequisite: credentials
  const credentials = loadCredentials();
  if (!credentials) {
    fail("not logged in to adit-cloud", `run ${strong("adit cloud login")} (or ${strong("adit cloud login --token <token>")}) first`);
    return null;
  }

  // Resolve server URL
  const cloudConfig = loadCloudConfig();
  const serverUrl =
    cloudConfig.serverUrl ?? credentials.serverUrl ?? DEFAULT_SERVER_URL;

  if (text) printTitle("Link", basename(config.projectRoot), serverHost(serverUrl), opts.dryRun ? stateWord("preview") : null);

  // Verify connectivity
  const client = new CloudClient(serverUrl, credentials);
  let deletionPolicy: ProjectDeletionPolicy | null = null;
  try {
    await client.get("/api/sync/health");
    if (!opts.dryRun) {
      deletionPolicy = await refreshProjectDeletionPolicy(
        client,
        config.projectRoot,
        config.projectId,
      );
    }
  } catch (error) {
    if (error instanceof CloudNetworkError) {
      fail(`cannot reach adit-cloud at ${serverUrl}`, "check your network connection, then retry");
    } else if (error instanceof CloudAuthError) {
      fail(`authentication failed: ${error.message}`, `run ${strong("adit cloud login")}, then retry`);
    } else {
      fail(`connection check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  config = loadInitializedProjectConfig("adit cloud link", config.projectRoot);
  if (!config) return null;
  if (config.cloudDeletedAt) {
    fail("this project identity was deleted from ADIT Cloud", `run ${strong("adit init")} to create a new project identity before linking again`);
    return null;
  }

  const issues = await precheckManifestRepositories(config);
  if (issues.length > 0) {
    for (const issue of issues) {
      printLine(
        `${marks.fail} ${issue.label}  ${issue.problem === "missing" ? "missing or no longer a Git repository" : "no git remote 'origin'"}`,
        { stream: "stderr" },
      );
    }
    const hints = [
      issues.some((issue) => issue.problem === "no-origin") ? `add one with ${strong("git remote add origin <url>")}` : null,
      issues.some((issue) => issue.problem === "missing") ? `re-run ${strong("adit init")} if the repository list changed` : null,
    ];
    fail(`cannot link yet: ${plural(issues.length, "repository problem")}`, joinParts(hints));
    return null;
  }

  // Repositories, then one row per repository as it finishes.
  const labels = config.repositories.map((repository) => repository.relativePath === "." ? repository.displayName : repository.relativePath);
  const nameWidth = Math.max(displayWidth("repository"), ...labels.map((label) => displayWidth(label)));
  const cells = (name: string, branches: string, commits: string, docs: string, time: string) =>
    `${padEnd(name, nameWidth)}  ${padEnd(branches, 8)}  ${padEnd(commits, 9)}  ${padEnd(docs, 4)}  ${time}`.trimEnd();
  const linkOptions: LinkOptions = { ...opts, deletionPolicyRefreshed: true };
  if (text) {
    const activePaths = new Set(config.repositories.map((repository) => repository.relativePath));
    const deleted = (deletionPolicy?.deletedRepositories ?? []).filter((repository) => !activePaths.has(repository.relativePath));
    printLine(`${marks.ok} ${dim(padEnd("Repositories", 12))}  ${labels.join(", ")} ${dim("· all have an origin")}`);
    if (deleted.length > 0) {
      printLine(`${marks.skip} ${dim(padEnd("Deleted", 12))}  ${deleted.map((repository) => repository.relativePath).join(", ")} ${dim("· deleted in Cloud, not linked")}`);
    }
    if (opts.force && !opts.dryRun) printLine(`${marks.change} ${dim(padEnd("Cache", 12))}  cleared · linking from scratch`);
    printLine();
    printLine(dim(`  ${cells("repository", "branches", "commits", "docs", opts.dryRun ? "" : "time")}`));

    const doneMark = opts.dryRun ? marks.skip : marks.ok;
    linkOptions.silent = true;
    linkOptions.onRepositoryStart = ({ relativePath }) => {
      printTransient(`${dim("…")} ${padEnd(relativePath === "." ? basename(config!.projectRoot) : relativePath, nameWidth)}  ${dim("linking")}`);
    };
    linkOptions.onRepositoryDone = ({ result, failure }) => {
      if (result) {
        const name = result.relativePath === "." ? basename(config!.projectRoot) : result.relativePath;
        printLine(`${doneMark} ${cells(name, formatCount(result.branchCount), formatCount(result.commitCount), formatCount(result.documentCount), opts.dryRun ? "" : formatDuration(result.totalDurationMs))}`);
      } else if (failure) {
        const name = failure.relativePath === "." ? basename(config!.projectRoot) : failure.relativePath;
        printLine(`${marks.fail} ${padEnd(name, nameWidth)}  ${truncate(`${failure.step ? `${failure.step}: ` : ""}${failure.message}`, 80)}`);
      }
    };
  }

  // Open database and run the link flow
  const db = openDatabase(config.dbPath);
  try {
    const result = await linkCommand(
      db,
      client,
      config.projectRoot,
      config.projectId,
      serverUrl,
      linkOptions,
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (text) {
      for (const similar of result.similarProjects ?? []) {
        printLine(`${marks.warn} another cloud project uses the same git remote: ${similar.name || "(unnamed project)"}${similar.lastActivityAt ? dim(` · last active ${similar.lastActivityAt.slice(0, 10)}`) : ""}`);
      }
      if (result.similarProjects && result.similarProjects.length > 0) {
        printLine(dim("  this link created a new project and merged nothing; delete leftovers on the cloud settings page"));
      }
      const repositories = result.repositoryResults?.length ?? 1;
      const totals = joinParts([
        plural(repositories, "repository", "repositories"),
        `${formatCount(result.commitCount)} commits`,
        plural(result.documentCount, "document"),
      ]);
      if (opts.dryRun) {
        printEnd(`${marks.skip} Preview only ${dim(`· ${totals} · nothing uploaded · run`)} ${strong("adit cloud link")} ${dim("to link")}`);
      } else {
        printEnd(`${marks.ok} Linked ${dim("·")} ${joinParts([`project ${shortId(result.serverProjectId, 8)}`, totals, formatDuration(result.totalDurationMs)])}`);
      }
    }
    return result;
  } catch (error) {
    const { step, cause } = unwrapLinkError(error);
    const prefix = step ? `${step}: ` : "";
    if (error instanceof CloudProjectDeletedError) {
      fail(error.message.replace(/\.$/u, ""), `run ${strong("adit init")} to create a new project identity`);
    } else if (error instanceof WorkspaceLinkPartialFailureError) {
      if (opts.json) {
        console.log(JSON.stringify(error.result, null, 2));
        process.exitCode = 1;
      } else {
        const failed = error.repositoryFailures.length;
        const total = failed + error.repositoryResults.length;
        fail(`${failed} of ${plural(total, "repository", "repositories")} failed to link`, `fix the problems above, then run ${strong("adit cloud link")} again`);
      }
    } else if (cause instanceof CloudApiError) {
      const body = cause.body === undefined || cause.body === null
        ? null
        : typeof cause.body === "string" ? cause.body : JSON.stringify(cause.body);
      fail(`${prefix}server error ${cause.status}: ${cause.message}`, body ? `response: ${truncate(body, 200)}` : undefined);
    } else if (cause instanceof CloudNetworkError) {
      fail(`${prefix}network error: ${cause.message}`, "check your connection, then retry");
    } else if (cause instanceof CloudAuthError) {
      fail(`${prefix}authentication failed: ${cause.message}`, `run ${strong("adit cloud login")}, then retry`);
    } else {
      fail(`${prefix}link failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return null;
  } finally {
    closeDatabase(db);
  }
}
