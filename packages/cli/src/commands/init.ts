/**
 * `adit init` — Initialize ADIT in the current project.
 *
 * The only command allowed to decide the project shape and write
 * `.adit/project.json`. Also creates the .adit/ data directory, initializes
 * the database, and installs hooks for detected (or specified) AI platforms.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, relative } from "node:path";
import pc from "picocolors";
import {
  loadConfig,
  openDatabase,
  closeDatabase,
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
import { marks, sectionTitle } from "./cli-style.js";
import { runCloudSetupSection } from "./init-cloud-setup.js";
import {
  buildPlatformChoices,
  diffSelection,
  printChoiceList,
  promptPlatformSelectionFallback,
  type PlatformChoice,
} from "./init-platform-select.js";
import { canUseInkSelect, runInkPlatformSelect } from "./init-select-ink.js";
import {
  renderProjectOverviewTemplate,
  renderArchitectureTemplate,
  renderApiReferenceTemplate,
  renderDataModelTemplate,
  renderGenerateDocsPrompt,
  GENERATE_DOCS_PROMPT_PATH,
} from "@varveai/adit-plans";
import { analyzeProjectLayout, resolveInitRoot } from "./project-layout.js";
import { prepareProjectManifest } from "./init-manifest.js";

export async function initCommand(opts: {
  cwd?: string;
  platform?: string;
  force?: boolean;
  singleRepo?: boolean;
  multiRepo?: boolean;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  console.log();
  console.log("  ADIT — AI Development Intent Tracker");
  console.log("  =====================================");
  console.log();

  const { root: projectRoot, reason } = resolveInitRoot(cwd);
  if (reason === "none") {
    console.error("  [x] Not a git repository, and no Git repositories were found one level below.");
    console.error("      Run 'git init' first, or run this from a directory that contains repositories.");
    process.exit(1);
  }

  const analysis = await analyzeProjectLayout(projectRoot);
  const plan = await prepareProjectManifest(projectRoot, analysis, {
    singleRepo: opts.singleRepo,
    multiRepo: opts.multiRepo,
  });

  if (plan.status === "cancelled") {
    console.log("  Initialization cancelled. Nothing was changed.");
    process.exit(1);
  }
  if (plan.status === "failed") {
    process.exit(1);
  }
  if (plan.status === "redirect-child") {
    await initCommand({ ...opts, cwd: plan.childPath, singleRepo: true, multiRepo: false });
    return;
  }

  const manifest = plan.manifest;
  if (manifest.cloudDeletedAt) {
    return;
  }
  const migratedFrom = plan.status === "written" ? plan.migratedFrom : null;
  const config = loadConfig(projectRoot);
  const setupRoot = config.projectRoot;

  // --- Step 1: Clean up if --force ---
  if (opts.force) {
    console.log("  Removing existing hooks (--force)...");
    for (const adapter of listAdapters()) {
      if (adapter.hookMappings.length === 0) continue;
      try {
        const result = await adapter.validateInstallation(setupRoot);
        if (result.valid) {
          await adapter.uninstallHooks(setupRoot);
          console.log(`    [~] Removed ${adapter.displayName} hooks`);
        }
      } catch {
        // best-effort cleanup
      }
    }
    console.log();
  }

  // --- Step 2: Data directory & database ---
  console.log(sectionTitle("  Setup"));

  const ok = marks.ok;
  mkdirSync(config.dataDir, { recursive: true });
  console.log(`  ${ok} Data directory: ${relative(setupRoot, config.dataDir) || "."}`);

  const db = openDatabase(config.dbPath);
  closeDatabase(db);
  console.log(`  ${ok} Database: ${relative(setupRoot, config.dbPath)}`);

  const typeLabel = manifest.projectType === "workspace" ? "multi-repo project" : "single-repo project";
  console.log(`  ${ok} ${typeLabel[0].toUpperCase()}${typeLabel.slice(1)}: ${pc.bold(basename(setupRoot))}`);
  console.log(`  ${ok} Project ID: ${manifest.projectId}`);
  if (manifest.projectType === "workspace") {
    console.log(`  ${ok} Repositories: ${manifest.repositories.length}`);
    for (const repo of manifest.repositories) {
      const state = repo.cloudDeletedAt
        ? " (deleted in Cloud)"
        : repo.syncEnabled === false
          ? " (not synced)"
          : "";
      console.log(pc.dim(`        - ${repo.relativePath}${state}`));
    }
  }
  if (migratedFrom) {
    console.log(`  ${ok} Migrated existing project — identity preserved (from ${migratedFrom}).`);
  }

  // Add .adit/ to .gitignore if not already there
  const gitignorePath = join(setupRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".adit/")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.adit/\n");
      console.log(`  ${ok} Added .adit/ to .gitignore`);
    } else {
      console.log(pc.dim("  [=] .gitignore already includes .adit/"));
    }
  } else {
    writeFileSync(gitignorePath, ".adit/\n");
    console.log(`  ${ok} Created .gitignore with .adit/`);
  }

  // --- Step 3: Platform detection & hook installation ---
  console.log();
  console.log(sectionTitle("  Platforms"));

  const aditBinaryPath = resolveAditHookBinary();
  const installed: string[] = [];
  const skipped: string[] = [];
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (opts.platform) {
    // Explicit platform specified — install exactly that one and record it.
    const platform = opts.platform as Platform;
    try {
      const adapter = getAdapter(platform);
      await adapter.installHooks(setupRoot, aditBinaryPath);
      await addConnectedPlatforms(setupRoot, [platform]);
      installed.push(adapter.displayName);
      console.log(`  ${marks.ok} ${adapter.displayName} ${pc.dim(`— ${adapter.hookMappings.length} hook events installed`)}`);
      await printAdvisoryWarnings(adapter, setupRoot);
    } catch (err) {
      skipped.push(platform);
      console.log(`  ${marks.fail} ${platform} — install failed: ${(err as Error).message}`);
    }
  } else {
    // Full-list selection: every supported platform is shown; connected ones
    // are pre-checked from the record, detection is annotation (and the
    // default only on a first run with no record).
    const recorded = readConnectedPlatforms(setupRoot);
    const connected = recorded ?? (await ensureConnectedPlatformsRecorded(setupRoot));
    const hasRecord = recorded !== null || connected.length > 0;
    const detected = detectInstalledPlatforms();
    const choices = buildPlatformChoices({ connected, detected, hasRecord });

    console.log("  Select the AI tools to record in this project:");
    let finalChecked: Set<Platform>;
    if (!interactive) {
      // Non-interactive runs never disconnect anything: keep the current
      // connections and add newly detected CLIs, same as before.
      finalChecked = new Set([
        ...choices.filter((choice) => choice.connected).map((choice) => choice.platform),
        ...choices
          .filter((choice) => choice.detected && !choice.manual)
          .map((choice) => choice.platform),
      ]);
      printChoiceList(choices);
      console.log("  Non-interactive run: keeping current connections and connecting newly detected tools.");
    } else {
      // Both widgets confirm disconnects themselves before returning.
      finalChecked = await selectPlatforms(choices);
    }

    const plan = diffSelection(choices, finalChecked);
    for (const platform of plan.toConnect) {
      try {
        const adapter = getAdapter(platform);
        await adapter.installHooks(setupRoot, aditBinaryPath);
        installed.push(adapter.displayName);
        console.log(`  ${marks.ok} ${adapter.displayName} ${pc.dim(`— ${adapter.hookMappings.length} hook events installed`)}`);
        await printAdvisoryWarnings(adapter, setupRoot);
      } catch (err) {
        skipped.push(platform);
        console.log(`  ${marks.fail} ${platform} — install failed: ${(err as Error).message}`);
      }
    }
    for (const platform of plan.toDisconnect) {
      try {
        const adapter = getAdapter(platform);
        await adapter.uninstallHooks(setupRoot);
        console.log(`  ${marks.change} ${adapter.displayName} ${pc.dim("— hooks removed")}`);
      } catch (err) {
        console.log(`  ${marks.fail} ${platform} — uninstall failed: ${(err as Error).message}`);
      }
    }
    // Refreshing still-connected platforms unconditionally keeps re-running
    // init as the repair path when a hook points at a removed adit install.
    for (const platform of plan.toRefresh) {
      try {
        const adapter = getAdapter(platform);
        if (adapter.hookMappings.length === 0) continue;
        await adapter.installHooks(setupRoot, aditBinaryPath);
        console.log(pc.dim(`  [=] ${adapter.displayName} — connected, hooks refreshed`));
        await printAdvisoryWarnings(adapter, setupRoot);
      } catch (err) {
        console.log(`  ${marks.fail} ${platform} — refresh failed: ${(err as Error).message}`);
      }
    }
    writeConnectedPlatforms(setupRoot, plan.finalRecord);
    console.log(pc.dim("  Tip: run 'adit init' any time to change these."));
  }

  // --- Cloud: optional login + link (skippable, never fails init) ---
  const cloudResult = await runCloudSetupSection({
    interactive,
    projectId: manifest.projectId,
    dbPath: config.dbPath,
  });

  // --- Step 4: Generate document templates ---
  console.log();
  console.log(sectionTitle("  Project Documents"));

  const docsDir = join(config.dataDir, "docs");
  const projectName = basename(setupRoot);
  const defaultDocTypes: Array<{ file: string; renderer: (title: string) => string }> = [
    { file: "project-overview.md", renderer: renderProjectOverviewTemplate },
    { file: "architecture.md", renderer: renderArchitectureTemplate },
    { file: "api-reference.md", renderer: renderApiReferenceTemplate },
    { file: "data-model.md", renderer: renderDataModelTemplate },
  ];

  let docsCreated = 0;
  let docsExisting = 0;

  for (const { file, renderer } of defaultDocTypes) {
    const filePath = join(docsDir, file);
    if (existsSync(filePath)) {
      docsExisting++;
    } else {
      if (docsCreated === 0) mkdirSync(docsDir, { recursive: true });
      writeFileSync(filePath, renderer(projectName), "utf-8");
      docsCreated++;
    }
  }

  // Always (re)write the AI prompt file. adit owns this copy — it is
  // refreshed on every init so upgrades propagate; users customize by
  // copying it (e.g. into their AI tool's skills/commands).
  const promptsDir = join(config.dataDir, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  const promptPath = join(promptsDir, "generate-docs.md");
  writeFileSync(promptPath, renderGenerateDocsPrompt(), "utf-8");

  if (docsCreated > 0) {
    const existingNote = docsExisting > 0 ? ` · ${docsExisting} already exist` : "";
    console.log(`  ${marks.ok} Created ${docsCreated} doc templates${pc.dim(existingNote)} + ${GENERATE_DOCS_PROMPT_PATH}`);
  } else {
    console.log(pc.dim(`  [=] ${docsExisting} doc templates exist · generate-docs prompt refreshed`));
  }

  // --- Summary ---
  console.log();
  const finalConnected = readConnectedPlatforms(setupRoot) ?? [];
  if (finalConnected.length > 0 || installed.length > 0) {
    console.log(pc.bold(pc.green("  Done! ADIT is ready.")));
    console.log();
    if (finalConnected.length > 0) {
      const names = finalConnected.map((platform) => getAdapter(platform).displayName);
      console.log(`  Connected platforms: ${names.join(", ")}`);
    } else {
      console.log(`  Installed for: ${installed.join(", ")}`);
    }
  } else {
    console.log(pc.bold(pc.green("  Done! ADIT data directory is ready (not recording yet).")));
    console.log();
    console.log("  No AI tools connected. Re-run 'adit init' after installing one,");
    console.log("  or run 'adit hook install <platform>' to connect one manually.");
  }
  if (skipped.length > 0) {
    console.log(`  ${pc.yellow("Skipped:")} ${skipped.join(", ")}`);
  }
  if (manifest.projectType === "workspace") {
    const repositoryScope = manifest.repositories.length === 1
      ? "the repository"
      : `all ${manifest.repositories.length} repositories`;
    console.log(pc.dim(`  Tip: start Claude Code / Codex from this directory — work across ${repositoryScope} is recorded;`));
    console.log(pc.dim("       sessions started inside a member repository are not."));
  }
  if (!cloudResult.linked) {
    console.log(`\n  ${pc.cyan("Next step:")} run ${pc.bold("adit cloud link")} to connect this project to the cloud.`);
  }
  console.log(`\n  ${pc.cyan("Next step:")} ask your AI agent to follow ${pc.bold(GENERATE_DOCS_PROMPT_PATH)}`);
  console.log(pc.dim("             (fills the project docs, also unlocks cloud qualification),"));
  console.log(`             then run ${pc.bold("'adit timeline'")} after your first prompt.`);
  console.log();
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
 * approval inside Codex (/hooks). Never fails init.
 */
async function printAdvisoryWarnings(
  adapter: ReturnType<typeof getAdapter>,
  setupRoot: string,
): Promise<void> {
  try {
    const result = await adapter.validateInstallation(setupRoot);
    for (const check of result.checks) {
      if (check.advisory && !check.ok) {
        console.log(`      ${marks.warn} ${check.detail}`);
      }
    }
  } catch {
    // advisory only
  }
}
