import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HISTORY_SKILL, REPORTS_SKILL, SKILLS, TASK_SKILL, installSkills } from "./skills.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const directory = mkdtempSync(join(tmpdir(), "adit-skills-")); homes.push(directory); return directory; }

describe("skill installation", () => {
  it("installs every skill into both agent locations and is idempotent", () => {
    const directory = home();
    const result = installSkills(directory);
    expect(result.errors).toEqual([]);
    expect(result.installed).toEqual(["agents", "claude"].flatMap((base) => SKILLS.map((skill) => join(directory, `.${base}`, "skills", skill.name, "SKILL.md"))));
    expect(result.installed.map((path) => readFileSync(path, "utf8"))).toEqual([TASK_SKILL, HISTORY_SKILL, REPORTS_SKILL, TASK_SKILL, HISTORY_SKILL, REPORTS_SKILL]);
    expect(installSkills(directory).unchanged).toEqual(result.installed);
  });

  it("updates only an unchanged ADIT-owned skill", () => {
    const directory = home();
    const [file] = installSkills(directory).installed;
    const old = "old ADIT skill";
    writeFileSync(file, old);
    writeFileSync(join(directory, ".agents", "skills", "adit-tasks", ".adit-managed.json"), JSON.stringify({ owner: "adit", sha256: createHash("sha256").update(old).digest("hex") }));
    expect(installSkills(directory).installed).toEqual([file]);
    writeFileSync(file, "user customized skill");
    expect(installSkills(directory).skipped).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe("user customized skill");
  });

  it("reports per-destination failure without aborting other installations", () => {
    const directory = home();
    writeFileSync(join(directory, ".agents"), "not a directory");
    const result = installSkills(directory);
    expect(result.errors).toHaveLength(SKILLS.length);
    expect(result.installed).toHaveLength(SKILLS.length);
  });

  it("keeps every skill in English with a frontmatter name matching its directory", () => {
    for (const skill of SKILLS) {
      expect(skill.content).toMatch(new RegExp(`^---\\nname: ${skill.name}\\ndescription: `));
      expect(skill.content).not.toMatch(/[一-鿿]/);
      expect(skill.content).not.toContain("`");
    }
  });
});
