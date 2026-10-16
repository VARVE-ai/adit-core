/**
 * Cloud section of `adit init` — optional login + project link.
 *
 * Strictly additive to init: every outcome here (declined, login aborted,
 * link failed, cloud unreachable) leaves the local initialization intact
 * and init exiting successfully; the user can always run `adit cloud link`
 * later. Non-interactive runs skip the section entirely.
 *
 * The link flow runs in silent mode and this module renders it in init's
 * own compact style: one line per completed step, then a result line built
 * from the LinkResult. Standalone `adit cloud link` keeps its detailed
 * output.
 */

import { createInterface } from "node:readline/promises";
import {
  closeDatabase,
  normalizeServerUrl,
  openDatabase,
} from "@varveai/adit-core";
import {
  DEFAULT_SERVER_URL,
  loadCloudConfig,
  loadCredentials,
} from "@varveai/adit-cloud";
import {
  dim,
  formatCount,
  formatDuration,
  joinParts,
  marks,
  printLine,
  printSection,
  promptPrefix,
  strong,
} from "./cli-style.js";
import { cloudLoginCommand } from "./cloud.js";
import { projectLinkCliHandler } from "./project-link.js";

export interface CloudSetupResult {
  linked: boolean;
}

export interface CloudSetupDeps {
  isLoggedIn: () => boolean;
  resolveServerUrl: () => string;
  isProjectLinked: (serverUrl: string) => boolean;
  login: () => Promise<boolean>;
  link: () => Promise<boolean>;
  askYes: (question: string) => Promise<boolean>;
}

export async function runCloudSetupSection(opts: {
  interactive: boolean;
  projectId: string;
  dbPath: string;
  deps?: Partial<CloudSetupDeps>;
}): Promise<CloudSetupResult> {
  const deps: CloudSetupDeps = {
    isLoggedIn: () => loadCredentials() !== null,
    resolveServerUrl: defaultResolveServerUrl,
    isProjectLinked: (serverUrl) =>
      defaultIsProjectLinked(opts.dbPath, opts.projectId, serverUrl),
    login: defaultLogin,
    link: runEmbeddedLink,
    askYes: defaultAskYes,
    ...opts.deps,
  };

  printSection("Cloud");

  const loggedIn = deps.isLoggedIn();
  const serverUrl = deps.resolveServerUrl();
  const server = serverHost(serverUrl);
  const later = `run ${strong("adit cloud link")} when ready`;

  if (loggedIn && deps.isProjectLinked(serverUrl)) {
    printLine(`${marks.skip} ${dim(`already linked · ${server}`)}`);
    return { linked: true };
  }

  if (!opts.interactive) {
    printLine(`${marks.skip} ${dim(`not linked · ${later}`)}`);
    return { linked: false };
  }

  if (!loggedIn) {
    const wantsCloud = await deps.askYes(
      `${promptPrefix()}Connect this project to adit-cloud (log in and link)? ${dim("(Y/n)")} `,
    );
    if (!wantsCloud) {
      printLine(`${marks.skip} ${dim(`skipped · ${later}`)}`);
      return { linked: false };
    }
    const loginOk = await deps.login();
    if (!loginOk) {
      printLine(`${marks.fail} login not completed · everything local is done; run ${strong("adit cloud link")} later`);
      return { linked: false };
    }
  } else {
    printLine(`${marks.skip} ${dim(`logged in · ${server}`)}`);
    const wantsLink = await deps.askYes(`${promptPrefix()}Link this project to adit-cloud? ${dim("(Y/n)")} `);
    if (!wantsLink) {
      printLine(`${marks.skip} ${dim(`skipped · ${later}`)}`);
      return { linked: false };
    }
  }

  const linkOk = await deps.link();
  if (!linkOk) {
    printLine(`${marks.fail} link failed · everything local is done; run ${strong("adit cloud link")} to retry`);
    return { linked: false };
  }
  return { linked: true };
}

/** Run the link flow silently and render init-style progress and summary. */
async function runEmbeddedLink(): Promise<boolean> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  let result: Awaited<ReturnType<typeof projectLinkCliHandler>> = null;
  try {
    result = await projectLinkCliHandler({
      silent: true,
      onStepComplete: (step) => {
        printLine(`${marks.ok} ${step.step} ${dim(formatDuration(step.durationMs))}`);
      },
    });
  } catch {
    result = null;
  }

  const failed = result === null || process.exitCode === 1;
  process.exitCode = previousExitCode;
  if (failed || result === null) return false;

  printLine(`${marks.ok} linked ${strong(result.projectName)} ${dim("·")} ${joinParts([
    `${formatCount(result.branchCount)} branches`,
    `${formatCount(result.commitCount)} commits`,
    `${formatCount(result.documentCount)} documents`,
    formatDuration(result.totalDurationMs),
  ])}`);
  if (result.similarProjects && result.similarProjects.length > 0) {
    printLine(`${marks.warn} ${result.similarProjects.length} existing cloud project(s) share this repository's remote · check the project list to avoid duplicates`);
  }
  return true;
}

async function defaultLogin(): Promise<boolean> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let failed = false;
  try {
    await cloudLoginCommand({ embedded: true });
    failed = process.exitCode === 1;
  } catch {
    failed = true;
  }
  process.exitCode = previousExitCode;
  return !failed && loadCredentials() !== null;
}

function defaultResolveServerUrl(): string {
  const cloudConfig = loadCloudConfig();
  const credentials = loadCredentials();
  return cloudConfig.serverUrl ?? credentials?.serverUrl ?? DEFAULT_SERVER_URL;
}

function defaultIsProjectLinked(
  dbPath: string,
  projectId: string,
  serverUrl: string,
): boolean {
  try {
    const db = openDatabase(dbPath);
    try {
      const rows = db
        .prepare("SELECT server_url FROM project_link_cache WHERE project_id = ?")
        .all(projectId) as Array<{ server_url: string }>;
      const wanted = normalizeServerUrl(serverUrl).toLowerCase();
      return rows.some(
        (row) => normalizeServerUrl(row.server_url).toLowerCase() === wanted,
      );
    } finally {
      closeDatabase(db);
    }
  } catch {
    return false;
  }
}

function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl;
  }
}

async function defaultAskYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
