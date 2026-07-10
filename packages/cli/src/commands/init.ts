/**
 * `adit init` — Initialize ADIT in the current project.
 *
 * Creates the .adit/ data directory, initializes the database,
 * and installs hooks for detected (or specified) AI platforms via adapters.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import {
  loadConfig,
  openDatabase,
  closeDatabase,
  findGitRoot,
  discoverWorkspaceRepositories,
  ensureWorkspaceManifest,
} from "@varveai/adit-core";
import type { Platform } from "@varveai/adit-core";
import { isGitRepo } from "@varveai/adit-engine";
import {
  getAdapter,
  listAdapters,
  detectPlatforms,
  resolveAditHookBinary,
} from "@varveai/adit-hooks/adapters";
import {
  renderProjectOverviewTemplate,
  renderArchitectureTemplate,
  renderApiReferenceTemplate,
  renderDataModelTemplate,
  renderGenerateDocsPrompt,
  GENERATE_DOCS_PROMPT_PATH,
} from "@varveai/adit-plans";

export async function initCommand(opts: {
  cwd?: string;
  platform?: string;
  force?: boolean;
  workspace?: boolean;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  console.log();
  console.log("  ADIT — AI Development Intent Tracker");
  console.log("  =====================================");
  console.log();

  const isRepo = await isGitRepo(cwd);
  let projectRoot = findGitRoot(cwd) ?? cwd;
  let discoveredWorkspaceRepoCount = 0;

  if (!isRepo) {
    const workspaceRepos = discoverWorkspaceRepositories(cwd);
    if (workspaceRepos.length === 0) {
      console.error("  [x] Not a git repository, and no Git repositories were found one level below.");
      console.error("      Run 'git init' first, or run this from a workspace parent directory.");
      process.exit(1);
    }

    console.log("  Workspace candidate detected.");
    console.log("  This directory is not a Git repository, but it contains Git repositories:");
    for (const repo of workspaceRepos) {
      console.log(`    - ${repo.relativePath}`);
    }
    console.log();

    if (!opts.workspace) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("  [x] Refusing to initialize a workspace without confirmation.");
        console.error("      Re-run with --workspace to confirm this multi-project setup.");
        process.exit(1);
      }

      const confirmed = await confirmWorkspaceInit();
      if (!confirmed) {
        console.log("  Workspace initialization cancelled.");
        process.exit(1);
      }
    }

    ensureWorkspaceManifest(cwd);
    projectRoot = cwd;
    discoveredWorkspaceRepoCount = workspaceRepos.length;
  }

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
  console.log("  Setup");
  console.log("  -----");

  mkdirSync(config.dataDir, { recursive: true });
  console.log(`  [+] Data directory: ${config.dataDir}`);

  const db = openDatabase(config.dbPath);
  closeDatabase(db);
  console.log(`  [+] Database: ${config.dbPath}`);

  if (config.projectType === "workspace") {
    const repoCount = discoveredWorkspaceRepoCount || config.repositories.length;
    console.log(`  [+] Workspace: ${config.projectId}`);
    console.log(`  [+] Repositories: ${repoCount}`);
  }

  // Add .adit/ to .gitignore if not already there
  const gitignorePath = join(setupRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".adit/")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.adit/\n");
      console.log("  [+] Added .adit/ to .gitignore");
    } else {
      console.log("  [+] .gitignore already includes .adit/");
    }
  } else {
    writeFileSync(gitignorePath, ".adit/\n");
    console.log("  [+] Created .gitignore with .adit/");
  }

  // --- Step 3: Platform detection & hook installation ---
  console.log();
  console.log("  Platforms");
  console.log("  ---------");

  const aditBinaryPath = resolveAditHookBinary();
  const installed: string[] = [];
  const skipped: string[] = [];

  if (opts.platform) {
    // Explicit platform specified
    const platform = opts.platform as Platform;
    try {
      const adapter = getAdapter(platform);
      await adapter.installHooks(setupRoot, aditBinaryPath);
      installed.push(adapter.displayName);
      console.log(`  [+] ${adapter.displayName} — ${adapter.hookMappings.length} hook events installed`);
    } catch (err) {
      skipped.push(platform);
      console.log(`  [x] ${platform} — install failed: ${(err as Error).message}`);
    }
  } else {
    // Auto-detect: install hooks for all detected platforms
    const platforms = detectPlatforms(setupRoot);
    if (platforms.length === 0) {
      console.log("  [ ] No AI platforms detected in this project.");
      console.log("      Supported: Claude Code (.claude/), OpenCode (.opencode/)");
      console.log("      Run 'adit hook install <platform>' to add one manually.");
    } else {
      for (const platform of platforms) {
        try {
          const adapter = getAdapter(platform);
          // Skip stub adapters (no hook mappings)
          if (adapter.hookMappings.length === 0) {
            skipped.push(adapter.displayName);
            console.log(`  [-] ${adapter.displayName} — detected but not yet supported`);
            continue;
          }
          await adapter.installHooks(setupRoot, aditBinaryPath);
          installed.push(adapter.displayName);
          console.log(`  [+] ${adapter.displayName} — ${adapter.hookMappings.length} hook events installed`);
        } catch (err) {
          skipped.push(platform);
          console.log(`  [x] ${platform} — install failed: ${(err as Error).message}`);
        }
      }
    }
  }

  // --- Step 4: Generate document templates ---
  console.log();
  console.log("  Project Documents");
  console.log("  -----------------");

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
      console.log(`  [=] ${file} already exists`);
    } else {
      if (docsCreated === 0) mkdirSync(docsDir, { recursive: true });
      writeFileSync(filePath, renderer(projectName), "utf-8");
      docsCreated++;
      console.log(`  [+] Created ${file}`);
    }
  }

  // Always (re)write the AI prompt file. adit owns this copy — it is
  // refreshed on every init so upgrades propagate; users customize by
  // copying it (e.g. into their AI tool's skills/commands).
  const promptsDir = join(config.dataDir, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  const promptPath = join(promptsDir, "generate-docs.md");
  const promptExisted = existsSync(promptPath);
  writeFileSync(promptPath, renderGenerateDocsPrompt(), "utf-8");
  console.log(`  [${promptExisted ? "=" : "+"}] ${promptExisted ? "Refreshed" : "Created"} ${GENERATE_DOCS_PROMPT_PATH}`);

  if (docsCreated > 0 || docsExisting > 0) {
    console.log(`\n  ${pc.cyan("Next step:")} Ask your AI agent to read ${pc.bold(GENERATE_DOCS_PROMPT_PATH)} and follow it to fill the documents.`);
  }

  // --- Summary ---
  console.log();
  if (installed.length > 0) {
    console.log("  Done! ADIT is ready.");
    console.log();
    console.log(`  Installed for: ${installed.join(", ")}`);
    console.log("  Run 'adit timeline' to view the timeline after your first prompt.");
  } else {
    console.log("  Done! ADIT data directory is ready.");
    console.log();
    console.log("  No platform hooks were installed.");
    console.log("  Run 'adit hook install <platform>' when you're ready to add one.");
  }
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.join(", ")}`);
  }
  console.log();
}

async function confirmWorkspaceInit(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      "  Initialize this parent directory as an ADIT workspace? Type 'yes' to continue: ",
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
