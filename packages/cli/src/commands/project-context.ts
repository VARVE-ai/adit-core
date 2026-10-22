import { join } from "node:path";
import { localDataDir, resolveLocalProject } from "@varveai/adit-core";
import { commandLabel, printError } from "./cli-style.js";

/** Identity-only commands do not depend on the legacy per-project event database. */
export function loadProjectContext(command: string, cwd?: string) {
  try {
    const project = resolveLocalProject({path:cwd});
    return {...project,dataDir:project.source === "registry" ? join(localDataDir(),"runtime",project.projectId) : join(project.projectRoot,".adit")};
  } catch (error) {
    printError(commandLabel(command),error instanceof Error ? error.message : "Project identification failed","open adit server and maintain the working directory in Settings");
    process.exitCode=1;
    return null;
  }
}
