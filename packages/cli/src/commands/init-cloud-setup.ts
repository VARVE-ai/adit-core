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
import pc from "picocolors";
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
import { marks, sectionTitle } from "./cli-style.js";
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

  console.log();
  console.log(sectionTitle("  Cloud"));

  const loggedIn = deps.isLoggedIn();
  const serverUrl = deps.resolveServerUrl();

  if (loggedIn && deps.isProjectLinked(serverUrl)) {
    console.log(pc.dim(`  [=] Logged in (${serverUrl})`));
    console.log(pc.dim("  [=] Project already linked"));
    return { linked: true };
  }

  if (!opts.interactive) {
    console.log(pc.dim("  [ ] Cloud setup skipped (non-interactive) — run 'adit cloud link' to connect."));
    return { linked: false };
  }

  if (!loggedIn) {
    const wantsCloud = await deps.askYes(
      `  Connect this project to adit-cloud (log in + link)? ${pc.dim("(Y/n):")} `,
    );
    if (!wantsCloud) {
      console.log(pc.dim("  [ ] Skipped — run 'adit cloud link' when ready."));
      return { linked: false };
    }
    const loginOk = await deps.login();
    if (!loginOk) {
      console.log(`  ${marks.fail} Login not completed — everything local is done; run 'adit cloud link' later.`);
      return { linked: false };
    }
  } else {
    console.log(pc.dim(`  [=] Logged in (${serverUrl})`));
    const wantsLink = await deps.askYes(`  Link this project to adit-cloud? ${pc.dim("(Y/n):")} `);
    if (!wantsLink) {
      console.log(pc.dim("  [ ] Skipped — run 'adit cloud link' when ready."));
      return { linked: false };
    }
  }

  const linkOk = await deps.link();
  if (!linkOk) {
    console.log(`  ${marks.fail} Link failed — everything local is done; run 'adit cloud link' to retry.`);
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
        console.log(`  ${marks.ok} ${step.step} ${pc.dim(`(${formatDuration(step.durationMs)})`)}`);
      },
    });
  } catch {
    result = null;
  }

  const failed = result === null || process.exitCode === 1;
  process.exitCode = previousExitCode;
  if (failed || result === null) return false;

  const stats = `${result.branchCount} branches · ${result.commitCount} commits · ${result.documentCount} documents`;
  console.log(
    `  ${marks.ok} Linked: ${pc.bold(result.projectName)} ${pc.dim(`— ${stats} (${formatDuration(result.totalDurationMs)})`)}`,
  );
  if (result.similarProjects && result.similarProjects.length > 0) {
    console.log(
      `  ${marks.warn} ${pc.dim(`${result.similarProjects.length} existing cloud project(s) share this repository's remote — check the project list to avoid duplicates`)}`,
    );
  }
  return true;
}

async function defaultLogin(): Promise<boolean> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let failed = false;
  try {
    await cloudLoginCommand();
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

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
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
