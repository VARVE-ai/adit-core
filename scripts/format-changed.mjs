import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function changedSourceFiles(root, base) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  let revision = "HEAD";
  if (base) {
    const commit = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
    revision = git(["merge-base", "HEAD", commit]).trim();
  }
  // Include staged, unstaged and untracked changes. Read working-tree contents;
  // this command does not stage files or claim to validate a separate index copy.
  const names = [
    git(["diff", "--name-only", "-z", "--diff-filter=ACMR", revision, "--", "packages"]),
    git([
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--diff-filter=ACMR",
      revision,
      "--",
      "packages",
    ]),
    git(["ls-files", "--others", "--exclude-standard", "-z", "--", "packages"]),
  ];
  return [...new Set(names.flatMap((value) => value.split("\0")))]
    .filter(
      (file) =>
        /^packages\/[^/]+\/src\/.+\.(ts|tsx)$/.test(file) && existsSync(path.join(root, file)),
    )
    .sort();
}

export async function checkChangedFormatting(root, { write = false, base } = {}) {
  const checked = [];
  const different = [];
  for (const file of changedSourceFiles(root, base)) {
    const absolute = path.join(root, file);
    const info = await prettier.getFileInfo(absolute, {
      ignorePath: path.join(root, ".prettierignore"),
    });
    if (info.ignored) continue;
    checked.push(file);
    const source = readFileSync(absolute, "utf8");
    const options = { ...(await prettier.resolveConfig(absolute)), filepath: absolute };
    if (await prettier.check(source, options)) continue;
    different.push(file);
    if (write) writeFileSync(absolute, await prettier.format(source, options));
  }
  return { checked, different };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (
    !["--check", "--write"].includes(mode) ||
    (args.length && (args.length !== 2 || args[0] !== "--base" || !args[1]))
  ) {
    throw new Error("Usage: format-changed.mjs --check|--write [--base <branch-or-commit>]");
  }
  const result = await checkChangedFormatting(projectRoot, {
    write: mode === "--write",
    base: args[1],
  });
  if (!result.checked.length) {
    console.log("No changed TypeScript/TSX files to check; the full source tree was not checked.");
    return;
  }
  for (const file of result.different)
    console.log(`${mode === "--write" ? "Formatted" : "Needs formatting"}: ${file}`);
  console.log(
    `Checked ${result.checked.length} changed source files; ${result.different.length} formatting differences${mode === "--write" ? " corrected" : ""}.`,
  );
  if (mode === "--check" && result.different.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
