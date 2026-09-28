import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installTaskSkill, TASK_SKILL } from "./task-skill.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const directory = mkdtempSync(join(tmpdir(), "adit-task-skill-")); homes.push(directory); return directory; }

describe("task skill installation", () => {
  it("installs both agent locations and is idempotent", () => {
    const directory = home();
    const result = installTaskSkill(directory);
    expect(result.errors).toEqual([]);
    expect(result.installed).toEqual([join(directory, ".agents", "skills", "adit-tasks", "SKILL.md"), join(directory, ".claude", "skills", "adit-tasks", "SKILL.md")]);
    expect(result.installed.map((path) => readFileSync(path, "utf8"))).toEqual([TASK_SKILL, TASK_SKILL]);
    expect(installTaskSkill(directory).unchanged).toEqual(result.installed);
  });

  it("updates only an unchanged ADIT-owned skill", () => {
    const directory = home();
    const [file] = installTaskSkill(directory).installed;
    const old = "old ADIT skill";
    writeFileSync(file, old);
    writeFileSync(join(directory, ".agents", "skills", "adit-tasks", ".adit-managed.json"), JSON.stringify({ owner: "adit", sha256: createHash("sha256").update(old).digest("hex") }));
    expect(installTaskSkill(directory).installed).toEqual([file]);
    writeFileSync(file, "user customized skill");
    expect(installTaskSkill(directory).skipped).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe("user customized skill");
  });

  it("reports per-destination failure without aborting other installations", () => {
    const directory = home();
    writeFileSync(join(directory, ".agents"), "not a directory");
    const result = installTaskSkill(directory);
    expect(result.errors).toHaveLength(1);
    expect(result.installed).toHaveLength(1);
  });
});
