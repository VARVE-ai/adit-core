/** Immutable per-platform-session project binding shared by hook processes. */
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionProject {
  projectRoot: string;
  projectId: string;
}

function bindingPath(platform: string, sessionId: string): string {
  const key = createHash("sha256").update(JSON.stringify([platform, sessionId])).digest("hex");
  return join(homedir(), ".adit", "hook-session-projects", `${key}.json`);
}

export function readSessionProject(platform: string, sessionId: string): SessionProject | null {
  try {
    const value = JSON.parse(readFileSync(bindingPath(platform, sessionId), "utf8")) as SessionProject;
    if (!value.projectRoot || !value.projectId) throw new Error("Invalid hook session project binding");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function bindSessionProject(platform: string, sessionId: string, project: SessionProject): SessionProject {
  const path = bindingPath(platform, sessionId);
  mkdirSync(join(homedir(), ".adit", "hook-session-projects"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ projectRoot: project.projectRoot, projectId: project.projectId }), { mode: 0o600 });
    try {
      // A fully written file becomes visible atomically. Concurrent hooks
      // adopt the winning binding instead of creating another project session.
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return readSessionProject(platform, sessionId)!;
  } finally {
    rmSync(temporary, { force: true });
  }
}
