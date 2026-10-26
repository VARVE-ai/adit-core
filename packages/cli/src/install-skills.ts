import { completeInstallation } from "./installation.js";

const versionOption = process.argv.indexOf("--expected-version");
completeInstallation({
  skillsOnly: process.argv.includes("--skills-only"),
  openBrowser: process.argv.includes("--open-browser"),
  expectedVersion: versionOption < 0 ? undefined : process.argv[versionOption + 1],
}).catch((error: unknown) => {
  console.error(`ADIT setup incomplete: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
