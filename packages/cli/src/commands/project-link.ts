/**
 * CLI handlers for `adit cloud link` and `adit cloud intent`.
 *
 * These wire up the config/credentials/database lifecycle around the
 * command handlers from @varveai/adit-cloud/project-link.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  openDatabase,
  closeDatabase,
  type AditConfig,
} from "@varveai/adit-core";
import {
  loadCloudConfig,
  loadCredentials,
  isTokenExpired,
  CloudClient,
  CloudAuthError,
  CloudNetworkError,
  CloudApiError,
  WorkspaceLinkPartialFailureError,
  linkCommand,
  intentCommand,
  formatIntentList,
  formatIntentDetail,
  DEFAULT_SERVER_URL,
  CloudProjectDeletedError,
  refreshProjectDeletionPolicy,
} from "@varveai/adit-cloud";
import type {
  LinkOptions,
  LinkResult,
  IntentOptions,
  ProjectDeletionPolicy,
} from "@varveai/adit-cloud";
import { getRemoteUrl } from "@varveai/adit-engine";
import { loadInitializedProjectConfig } from "./project-initialization.js";

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

function reportPrecheckIssues(issues: RepositoryPrecheckIssue[]): void {
  console.error("Cannot link this project yet:");
  for (const issue of issues) {
    if (issue.problem === "missing") {
      console.error(`  - ${issue.label}: repository is missing or no longer a Git repository.`);
    } else {
      console.error(`  - ${issue.label}: no git remote 'origin'. Add one with: git remote add origin <url>`);
    }
  }
  if (issues.some((issue) => issue.problem === "missing")) {
    console.error("\nIf the project structure changed, re-run 'adit init' to update the repository list.");
  }
}

/**
 * `adit cloud link` — Link this project to adit-cloud.
 *
 * Returns the link result on success so callers embedding the link flow
 * (adit init) can render their own summary; null on any failure.
 */
export async function projectLinkCliHandler(opts: LinkOptions): Promise<LinkResult | null> {
  let config = loadInitializedProjectConfig("adit cloud link");
  if (!config) return null;

  // Prerequisite: credentials
  const credentials = loadCredentials();
  if (!credentials) {
    console.error("Not logged in to adit-cloud.");
    console.error(
      "Run 'adit cloud login' to authenticate, or 'adit cloud login --token <token>' for token auth.",
    );
    process.exitCode = 1;
    return null;
  }

  if (isTokenExpired(credentials) && credentials.authType !== "token" && !opts.silent) {
    // CloudClient will attempt auto-refresh — just warn
    console.log("Token expired — will attempt auto-refresh...");
  }

  // Resolve server URL
  const cloudConfig = loadCloudConfig();
  const serverUrl =
    cloudConfig.serverUrl ?? credentials.serverUrl ?? DEFAULT_SERVER_URL;

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
      console.error(
        `Cannot reach adit-cloud at ${serverUrl}. Check your network connection.`,
      );
    } else if (error instanceof CloudAuthError) {
      console.error(`Authentication failed: ${error.message}`);
      console.error("Run 'adit cloud login' to re-authenticate.");
    } else {
      console.error(
        `Connection check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
    return null;
  }

  config = loadInitializedProjectConfig("adit cloud link", config.projectRoot);
  if (!config) return null;
  if (config.cloudDeletedAt) {
    console.error("This project identity was deleted from ADIT Cloud.");
    console.error("Run 'adit init' to create a new project identity before linking again.");
    process.exitCode = 1;
    return null;
  }

  const issues = await precheckManifestRepositories(config);
  if (issues.length > 0) {
    reportPrecheckIssues(issues);
    process.exitCode = 1;
    return null;
  }
  if (!opts.json && !opts.silent) {
    console.log("Checking project repositories...");
    const activePaths = new Set(
      config.repositories.map((repository) => repository.relativePath),
    );
    for (const repository of deletionPolicy?.deletedRepositories ?? []) {
      if (!activePaths.has(repository.relativePath)) {
        console.log(`  [-] ${repository.relativePath} (deleted in Cloud)`);
      }
    }
    for (const repository of config.repositories) {
      const label = repository.relativePath === "." ? repository.displayName : repository.relativePath;
      console.log(`  [+] ${label}`);
    }
  }

  // Suppress non-JSON output in JSON/silent mode
  if (!opts.json && !opts.silent) {
    console.log(`Authenticated on ${serverUrl}`);
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
      { ...opts, deletionPolicyRefreshed: true },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  } catch (error) {
    if (error instanceof CloudProjectDeletedError) {
      console.error(error.message);
      process.exitCode = 1;
    } else if (error instanceof WorkspaceLinkPartialFailureError) {
      if (opts.json) {
        console.log(JSON.stringify(error.result, null, 2));
      }
      process.exitCode = 1;
    } else if (error instanceof CloudApiError) {
      console.error(`\nServer error: ${error.status} — ${error.message}`);
      if (error.body) {
        const bodyStr =
          typeof error.body === "string"
            ? error.body
            : JSON.stringify(error.body, null, 2);
        console.error(`  Response: ${bodyStr}`);
      }
    } else if (error instanceof CloudNetworkError) {
      console.error(`\nNetwork error: ${error.message}`);
    } else if (error instanceof CloudAuthError) {
      console.error(`\nAuthentication failed: ${error.message}`);
      console.error("Run 'adit cloud login' to re-authenticate.");
    } else {
      console.error(
        `\nLink failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
    return null;
  } finally {
    closeDatabase(db);
  }
}

/**
 * `adit cloud intent` — List or show intents from connected project.
 */
export async function projectIntentCliHandler(
  opts: IntentOptions,
): Promise<void> {
  const config = loadInitializedProjectConfig("adit cloud intent");
  if (!config) return;

  // Prerequisite: credentials
  const credentials = loadCredentials();
  if (!credentials) {
    console.error(
      "Not logged in to adit-cloud. Run 'adit cloud login' to authenticate.",
    );
    process.exitCode = 1;
    return;
  }

  // Resolve server URL and project ID
  const cloudConfig = loadCloudConfig();
  const serverUrl =
    cloudConfig.serverUrl ?? credentials.serverUrl ?? DEFAULT_SERVER_URL;
  const client = new CloudClient(serverUrl, credentials);

  try {
    const result = await intentCommand(client, config.projectId, opts);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.intent) {
      console.log(formatIntentDetail(result.intent));
    } else if (result.intents) {
      console.log(formatIntentList(result.intents));
    }
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) {
      console.error("No project link found. Run 'adit cloud link' first.");
    } else if (error instanceof CloudApiError) {
      console.error(`Server error: ${error.status} — ${error.message}`);
    } else {
      console.error(
        `Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
  }
}
