/**
 * `adit init` — Initialize ADIT in the current project.
 *
 * The only command allowed to decide the project shape and write
 * `.adit/project.json`. Also creates the .adit/ data directory, initializes
 * the database, and installs hooks for detected (or specified) AI platforms.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, relative } from "node:path";
import {
  loadConfig,
  openDatabase,
  closeDatabase,
  projectManifestPath,
} from "@varveai/adit-core";
import type { Platform } from "@varveai/adit-core";
import {
  getAdapter,
  listAdapters,
  detectInstalledPlatforms,
  resolveAditHookBinary,
} from "@varveai/adit-hooks/adapters";
import {
  addConnectedPlatforms,
  ensureConnectedPlatformsRecorded,
  readConnectedPlatforms,
  writeConnectedPlatforms,
} from "./connected-platforms.js";
import {
  dim,
  formatRow,
  isBlockOpen,
  joinParts,
  marks,
  plural,
  printEnd,
  printError,
  printLine,
  printSection,
  printTitle,
  shortId,
  strong,
} from "./cli-style.js";
import { installSkillsWithReport, printSkillsSection, skillWarnings } from "./skills.js";
import { runCloudSetupSection } from "./init-cloud-setup.js";
import {
  BUNDLED_PLATFORMS,
  buildPlatformChoices,
  diffSelection,
  promptPlatformSelectionFallback,
  type PlatformChoice,
} from "./init-platform-select.js";
import { canUseInkSelect, runInkPlatformSelect } from "./init-select-ink.js";
import { analyzeProjectLayout, resolveInitRoot } from "./project-layout.js";
import { prepareProjectManifest } from "./init-manifest.js";

interface InitOptions {
  cwd?: string;
  platform?: string;
  force?: boolean;
  singleRepo?: boolean;
  multiRepo?: boolean;
  repos?: string[];
  detach?: boolean;
  absorb?: boolean;
}

export async function initCommand(opts: InitOptions): Promise<void> {
  const keys = ["ADIT_PROJECT_ROOT", "ADIT_DATA_DIR", "ADIT_DB_PATH"] as const;
  const previous = keys.map((key) => process.env[key]);
  const root = resolveInitRoot(opts.cwd ?? process.cwd()).root;
  process.env.ADIT_PROJECT_ROOT = root;
  // A tool may have inherited the parent's fixed hook environment. Explicit
  // init in a child must also initialize/link the child's own database.
  if (previous[0] && previous[0] !== root) {
    delete process.env.ADIT_DATA_DIR;
    delete process.env.ADIT_DB_PATH;
  }
  try {
    await initializeProject(opts);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

/** Every row label in init lines up at this width ("Claude Code (VS Code)"). */
const LABEL_WIDTH = 21;

function printRow(mark: string, label: string, value: string): void {
  printLine(formatRow({ mark, label, value }, LABEL_WIDTH));
}

/** The bundle owner whose hook configuration a companion platform shares, if any. */
function bundleOwner(platform: Platform): Platform | null {
  for (const [owner, companions] of Object.entries(BUNDLED_PLATFORMS)) {
    if (companions?.includes(platform)) return owner as Platform;
  }
  return null;
}

async function initializeProject(opts: InitOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  const { root: projectRoot, reason } = resolveInitRoot(cwd);
  if (reason === "none") {
    printError(
      "init",
      "not a Git repository, and no Git repositories were found one level below",
      `run ${strong("git init")} first, or run ${strong("adit init")} in a directory that contains repositories`,
    );
    process.exit(1);
  }

  const alreadyInitialized = existsSync(projectManifestPath(projectRoot));
  printTitle("Init", basename(projectRoot), alreadyInitialized ? "already initialized" : null);

  const analysis = await analyzeProjectLayout(projectRoot);
  const plan = await prepareProjectManifest(projectRoot, analysis, {
    singleRepo: opts.singleRepo,
    multiRepo: opts.multiRepo,
    repos: opts.repos,
    detach: opts.detach,
    absorb: opts.absorb,
  });

  if (plan.status === "cancelled") {
    printError("init", "initialization cancelled · nothing was changed");
    process.exit(1);
  }
  if (plan.status === "failed") {
    if (isBlockOpen()) printError("init", "init stopped · nothing was changed");
    process.exit(1);
  }

  const manifest = plan.manifest;
  if (manifest.cloudDeletedAt) {
    printEnd(`${marks.warn} Project deleted in ADIT Cloud · nothing else was changed`);
    return;
  }
  const migratedFrom = plan.status === "written" ? plan.migratedFrom : null;
  const config = loadConfig(projectRoot);
  const setupRoot = config.projectRoot;
  // Skills install first, as before; their section prints after the project rows.
  const skills = installSkillsWithReport();

  // --- Step 1: Clean up if --force ---
  if (opts.force) {
    for (const adapter of listAdapters()) {
      if (adapter.hookMappings.length === 0) continue;
      try {
        const result = await adapter.validateInstallation(setupRoot);
        if (result.valid) {
          await adapter.uninstallHooks(setupRoot);
          printRow(marks.change, adapter.displayName, "hooks removed (--force)");
        }
      } catch {
        // best-effort cleanup
      }
    }
  }

  // --- Step 2: Project, data directory & database ---
  // The manifest write already created .adit/, so the database tells a first run apart.
  const databaseExisted = existsSync(config.dbPath);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.dbPath);
  closeDatabase(db);

  const unchanged = plan.status === "unchanged";
  const repositoryNames = manifest.repositories.map((repo) => {
    const label = repo.relativePath === "." ? "./" : repo.relativePath;
    const state = repo.cloudDeletedAt ? "deleted in Cloud" : repo.syncEnabled === false ? "excluded, history kept" : null;
    return state ? `${label} ${dim(`(${state})`)}` : label;
  });
  const repositoryCount = plural(manifest.repositories.length, "repository", "repositories");
  const multiRepo = manifest.repositories.some((repo) => repo.relativePath !== ".");
  const recordedScope = manifest.repositories.length === 1 ? "the repository" : `all ${manifest.repositories.length} repositories`;
  printRow(
    unchanged ? marks.skip : marks.ok,
    "Project",
    joinParts([
      strong(basename(setupRoot)),
      shortId(manifest.projectId, 8),
      unchanged ? `${repositoryCount}, unchanged` : `${repositoryCount} (${repositoryNames.join(", ")})`,
    ]) + (multiRepo
      ? `\n${dim(`sessions started here record work across ${recordedScope}; a child initialized on its own keeps its own sessions`)}`
      : ""),
  );
  if (migratedFrom) {
    printRow(marks.ok, "Migrated", `identity preserved ${dim(`(from ${migratedFrom})`)}`);
  }
  printRow(
    databaseExisted ? marks.skip : marks.ok,
    "Data directory",
    `${relative(setupRoot, config.dataDir) || "."} ${dim("·")} database ${relative(setupRoot, config.dbPath)}`,
  );

  // Add .adit/ to .gitignore if not already there
  const gitignorePath = join(setupRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".adit/")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.adit/\n");
      printRow(marks.ok, ".gitignore", "added .adit/");
    } else {
      printRow(marks.skip, ".gitignore", dim("already includes .adit/"));
    }
  } else {
    writeFileSync(gitignorePath, ".adit/\n");
    printRow(marks.ok, ".gitignore", "created with .adit/");
  }

  printSkillsSection(skills, LABEL_WIDTH);

  // --- Step 3: Platform detection & hook installation ---
  const aditBinaryPath = resolveAditHookBinary();
  const installed: string[] = [];
  const failed: string[] = [];
  let warnings = skillWarnings(skills);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const installedRow = (platform: Platform, adapter: ReturnType<typeof getAdapter>) => {
    const owner = bundleOwner(platform);
    printRow(
      marks.ok,
      adapter.displayName,
      owner ? `shares the ${getAdapter(owner).displayName} hooks` : `${adapter.hookMappings.length} hook events installed`,
    );
  };
  const notSelectedRows = (choices: PlatformChoice[], selected: Set<Platform>) => {
    for (const choice of choices) {
      if (selected.has(choice.platform) || choice.connected) continue;
      printRow(
        marks.skip,
        choice.displayName,
        choice.detected
          ? dim(`detected, not selected · connect: ${strong(`adit hook install ${choice.platform}`)}`)
          : choice.manual
            ? dim(`not detectable · connect: ${strong(`adit hook install ${choice.platform}`)}`)
            : dim("not found on PATH"),
      );
    }
  };

  if (opts.platform) {
    printSection("Platforms");
    // Explicit platform specified — install exactly that one and record it.
    const platform = (opts.platform === "cursor" ? "claude-code" : opts.platform) as Platform;
    try {
      const adapter = getAdapter(platform);
      await adapter.installHooks(setupRoot, aditBinaryPath);
      await addConnectedPlatforms(setupRoot, [platform]);
      installed.push(adapter.displayName);
      installedRow(platform, adapter);
      warnings += await printAdvisoryWarnings(adapter, setupRoot);
      for (const companion of BUNDLED_PLATFORMS[platform] ?? []) {
        installedRow(companion, getAdapter(companion));
      }
    } catch (err) {
      failed.push(platform);
      printRow(marks.fail, platform, `install failed: ${(err as Error).message}`);
    }
    const connectedNow = readConnectedPlatforms(setupRoot) ?? [];
    notSelectedRows(
      buildPlatformChoices({ connected: connectedNow, detected: detectInstalledPlatforms(), hasRecord: true }),
      new Set(connectedNow),
    );
  } else {
    // Full-list selection: every supported platform is shown; connected ones
    // are pre-checked from the record, detection is annotation (and the
    // default only on a first run with no record).
    const recorded = readConnectedPlatforms(setupRoot);
    const connected = recorded ?? (await ensureConnectedPlatformsRecorded(setupRoot));
    const hasRecord = recorded !== null || connected.length > 0;
    const detected = detectInstalledPlatforms();
    const choices = buildPlatformChoices({ connected, detected, hasRecord });

    let finalChecked: Set<Platform>;
    if (!interactive) {
      // Non-interactive runs never disconnect anything: keep the current
      // connections and add newly detected CLIs, same as before.
      printSection("Platforms", "kept current, added newly detected");
      finalChecked = new Set([
        ...choices.filter((choice) => choice.connected).map((choice) => choice.platform),
        ...choices
          .filter((choice) => choice.detected && !choice.manual)
          .map((choice) => choice.platform),
      ]);
    } else {
      printSection("Platforms");
      printLine("Select the AI tools to record in this project:");
      printLine(dim("Claude Code / Cursor shares one hook configuration; Cursor does not require the Claude CLI."));
      // Both widgets confirm disconnects themselves before returning.
      finalChecked = await selectPlatforms(choices);
    }

    const selection = diffSelection(choices, finalChecked);
    for (const platform of selection.toConnect) {
      try {
        const adapter = getAdapter(platform);
        await adapter.installHooks(setupRoot, aditBinaryPath);
        installed.push(adapter.displayName);
        installedRow(platform, adapter);
        warnings += await printAdvisoryWarnings(adapter, setupRoot);
      } catch (err) {
        failed.push(platform);
        printRow(marks.fail, platform, `install failed: ${(err as Error).message}`);
      }
    }
    for (const platform of selection.toDisconnect) {
      try {
        const adapter = getAdapter(platform);
        await adapter.uninstallHooks(setupRoot);
        printRow(marks.change, adapter.displayName, "hooks removed");
      } catch (err) {
        failed.push(platform);
        printRow(marks.fail, platform, `uninstall failed: ${(err as Error).message}`);
      }
    }
    // Refreshing still-connected platforms unconditionally keeps re-running
    // init as the repair path when a hook points at a removed adit install.
    for (const platform of selection.toRefresh) {
      try {
        const adapter = getAdapter(platform);
        if (adapter.hookMappings.length === 0) continue;
        await adapter.installHooks(setupRoot, aditBinaryPath);
        printRow(marks.skip, adapter.displayName, dim("connected · hooks refreshed"));
        warnings += await printAdvisoryWarnings(adapter, setupRoot);
      } catch (err) {
        failed.push(platform);
        printRow(marks.fail, platform, `refresh failed: ${(err as Error).message}`);
      }
    }
    writeConnectedPlatforms(setupRoot, selection.finalRecord);
    notSelectedRows(choices, finalChecked);
  }

  // --- Cloud: optional login + link (skippable, never fails init) ---
  await runCloudSetupSection({
    interactive,
    projectId: manifest.projectId,
    dbPath: config.dbPath,
  });

  // --- Summary ---
  const finalConnected = readConnectedPlatforms(setupRoot) ?? [];
  const updatedSkills = skills.skills.filter((skill) => skill.state === "updated").length;
  const problems = warnings + failed.length;
  if (finalConnected.length > 0 || installed.length > 0) {
    if (problems > 0) {
      printEnd(`${marks.warn} Ready with ${plural(problems, "warning")} ${dim("·")} ${joinParts([
        `${plural(finalConnected.length || installed.length, "platform")} connected`,
        updatedSkills > 0 ? `${plural(updatedSkills, "skill")} updated` : null,
      ])}`);
    } else {
      const tool = finalConnected.length > 0 ? getAdapter(finalConnected[0]!).displayName : installed[0];
      printEnd(`${marks.ok} Ready ${dim("·")} start ${tool} ${multiRepo ? "from this directory" : "here"}, then run ${strong("adit timeline")} after your first prompt`);
    }
  } else {
    printEnd(`${marks.warn} Data directory ready, not recording yet ${dim("·")} connect a tool with ${strong("adit hook install <platform>")} or re-run ${strong("adit init")}`);
  }
}

/**
 * Run the checkbox selection: the ink widget where the terminal supports it,
 * the plain readline prompt otherwise (or when ADIT_PLAIN_PROMPTS is set).
 */
async function selectPlatforms(choices: PlatformChoice[]): Promise<Set<Platform>> {
  if (canUseInkSelect()) {
    try {
      return await runInkPlatformSelect(choices);
    } catch {
      // Terminal rejected raw mode — fall through to the plain prompt.
    }
  }
  return promptPlatformSelectionFallback(choices);
}

/**
 * Print advisory validation findings after a hook install — things a
 * reinstall cannot fix, such as Codex hooks still awaiting the user's
 * approval inside Codex (/hooks). Never fails init. Returns how many.
 */
async function printAdvisoryWarnings(
  adapter: ReturnType<typeof getAdapter>,
  setupRoot: string,
): Promise<number> {
  let count = 0;
  try {
    const result = await adapter.validateInstallation(setupRoot);
    for (const check of result.checks) {
      if (check.advisory && !check.ok) {
        printLine(`    ${marks.warn} ${check.detail}`);
        count += 1;
      }
    }
  } catch {
    // advisory only
  }
  return count;
}
