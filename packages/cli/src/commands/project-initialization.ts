/** Registry-only project guard; legacy identities are adopted by explicit init. */
import { loadConfig, type AditConfig } from "@varveai/adit-core";
import { commandLabel, printError } from "./cli-style.js";

export function formatAditProjectNotInitializedMessage(command: string): string {
  return [
    "ADIT is not initialized in this project.",
    "",
    "Run:",
    "  adit init",
    "",
    "Then retry:",
    `  ${command}`,
  ].join("\n");
}

export function loadInitializedProjectConfig(command:string,cwd?:string):AditConfig|null {
  try{return loadConfig(cwd);}catch(error){printError(commandLabel(command),error instanceof Error?error.message:String(error),"run adit init or open Settings");process.exitCode=1;return null;}
}
