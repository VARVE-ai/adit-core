import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SKILLS } from "../commands/skills.js";
import { CLI_VERSION } from "../version.js";
const exec = promisify(execFile);
export async function runtimeStatus() {
  let cli: { path?: string; version?: string; error?: string } = {};
  try {
    const { stdout } = await exec(
      process.platform === "win32" ? "where.exe" : "which",
      ["adit"],
      { windowsHide: true, timeout: 5000 },
    );
    cli.path = stdout.trim().split(/\r?\n/)[0];
    // Do not execute a shell script or invoke project initialization for a check.
  } catch {
    cli.error = "CLI was not found on PATH";
  }
  const skills = SKILLS.map((skill) => ({
    name: skill.name,
    platforms: [".claude", ".agents"].map((platform) => {
      const path = join(homedir(), platform, "skills", skill.name, "SKILL.md");
      try {
        const actual = readFileSync(path, "utf8")
          .replaceAll("\r\n", "\n")
          .trim();
        return {
          platform,
          path,
          status:
            actual === skill.content.replaceAll("\r\n", "\n").trim()
              ? "installed"
              : "modified",
        };
      } catch (e) {
        return {
          platform,
          path,
          status:
            (e as NodeJS.ErrnoException).code === "ENOENT"
              ? "missing"
              : "inaccessible",
        };
      }
    }),
  }));
  return {
    version: CLI_VERSION,
    executable: process.execPath,
    cli,
    skills,
    checkedAt: new Date().toISOString(),
  };
}
