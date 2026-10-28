import { installSkillsCommand } from "./commands/skills.js";
import { CLI_VERSION } from "./version.js";

/** Finish in the user's account, using the newly installed package's code. */
export async function completeInstallation(options: { skillsOnly?: boolean; expectedVersion?: string; openBrowser?: boolean } = {}): Promise<void> {
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
    throw new Error("User setup cannot run as root. Run 'adit update' from your regular user account, without sudo.");
  }
  if (options.expectedVersion && options.expectedVersion !== CLI_VERSION) {
    throw new Error(`Expected ADIT v${options.expectedVersion}, but the installed package is v${CLI_VERSION}. Reinstall the requested version before restarting the service.`);
  }
  const skills = installSkillsCommand();
  if (skills.errors.length) {
    throw new Error("Skill installation is incomplete. Fix the reported paths and run 'adit update' to retry. The background service was not changed.");
  }
  if (options.skillsOnly) return;

  // Load service dependencies before stopping the old process. A broken new
  // package must not stop a working service merely because an import failed.
  const { daemonStatus, stopDaemon, startDaemon, openBrowser } = await import("./local/daemon.js");
  const previous = await daemonStatus();
  if (previous) {
    try { await stopDaemon(); }
    catch (error) { throw new Error(`Could not stop the previous background service: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const current = await startDaemon().catch((error: unknown) => {
    throw new Error(`Could not start the new background service. Run 'adit restart' to retry: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (current.version !== CLI_VERSION || (previous && current.instance === previous.instance)) {
    throw new Error("The new background service could not be verified. Run 'adit restart' and check its status.");
  }
  console.log(`ADIT v${CLI_VERSION} background service ${previous ? "restarted" : "started"}: ${current.url}`);
  if (skills.skipped.length) {
    console.warn(`Service ready; ${skills.skipped.length} existing or customized Skill copies were kept, not updated.`);
  } else {
    console.log("ADIT setup complete: Skills are current and the background service is ready.");
  }
  if (options.openBrowser) openBrowser(current.url);
}
