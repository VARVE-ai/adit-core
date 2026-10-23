/** The event-database TUI was replaced by the shared local workbench. */
export async function launchTui():Promise<void>{const {serveCommand}=await import("../local/daemon.js");await serveCommand({});}
