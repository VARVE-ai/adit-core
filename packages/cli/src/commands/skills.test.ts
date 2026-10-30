import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKILLS, TASK_SKILL, installSkills } from "./skills.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() {
  const directory = mkdtempSync(join(tmpdir(), "adit-skills-"));
  homes.push(directory);
  return directory;
}

describe("skill installation", () => {
  it("documents document uploads, compatible images and partial failure recovery", () => {
    expect(TASK_SKILL).toContain("--file");
    expect(TASK_SKILL).toContain("--image");
    expect(TASK_SKILL).toContain("MD, TXT, DOCX, PDF, HTML and HTM");
    expect(TASK_SKILL).toContain("10 MB");
    expect(TASK_SKILL).toContain("20 MB");
    expect(TASK_SKILL).toContain("pendingFiles");
    expect(TASK_SKILL).toContain("pendingImages");
    expect(TASK_SKILL).toContain("do not recreate the task");
    expect(TASK_SKILL).toContain("Older CLI versions");
    expect(TASK_SKILL).toContain("do not rename a document to an image");
    expect(TASK_SKILL).not.toContain("### Image attachments");
  });
  it("documents explicit task creation, scope selection and safe uncertain-outcome handling", () => {
    expect(TASK_SKILL).toContain("adit cloud tasks create --title");
    expect(TASK_SKILL).toContain("Create only when the user asks");
    expect(TASK_SKILL).toContain("TEAM_SELECTION_REQUIRED");
    expect(TASK_SKILL).toContain("do not blindly retry");
    expect(TASK_SKILL).toContain("blueprintId null");
    expect(TASK_SKILL).toContain("--estimate-hours 2");
    expect(TASK_SKILL).toContain("1 person-day = 8 hours");
    expect(TASK_SKILL).toContain("estimatedPersonDays=0.25");
    expect(TASK_SKILL).toContain("--clear-estimate");
    expect(TASK_SKILL).toContain("adit cloud tasks types list --json");
    expect(TASK_SKILL).toContain("taskType and taskTypeColor");
    expect(TASK_SKILL).toContain("--clear-type");
    expect(TASK_SKILL).toContain("never changes existing tasks");
    expect(TASK_SKILL).toContain("same permissions and completed-task freezes");
    expect(TASK_SKILL).toContain("timeline.entries");
    expect(TASK_SKILL).toContain("--timeline-cursor");
    expect(TASK_SKILL).toContain("Follow nextCursor until null");
    expect(TASK_SKILL).toContain("unavailable, not no changes");
  });
  it("installs every skill into both agent locations and is idempotent", () => {
    const directory = home();
    const result = installSkills(directory);
    expect(result.errors).toEqual([]);
    expect(result.installed).toEqual(
      ["agents", "claude"].flatMap((base) =>
        SKILLS.map((skill) => join(directory, `.${base}`, "skills", skill.name, "SKILL.md")),
      ),
    );
    expect(result.installed.map((path) => readFileSync(path, "utf8"))).toEqual(
      ["agents", "claude"].flatMap(() => SKILLS.map((skill) => skill.content)),
    );
    expect(installSkills(directory).unchanged).toEqual(result.installed);
  });

  it("updates only an unchanged ADIT-owned skill", () => {
    const directory = home();
    const [file] = installSkills(directory).installed;
    const old = "old ADIT skill";
    writeFileSync(file, old);
    writeFileSync(
      join(directory, ".agents", "skills", "adit-tasks", ".adit-managed.json"),
      JSON.stringify({ owner: "adit", sha256: createHash("sha256").update(old).digest("hex") }),
    );
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
