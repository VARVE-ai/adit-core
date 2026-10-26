const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

// adit update finishes once, after the package manager has fully returned.
if (process.env.ADIT_DEFER_INSTALL_SETUP !== "1") {
  const source = Object.values(require("./package.json").dependencies || {}).some(value => value.startsWith("workspace:"));
  const entry = join(__dirname, "dist", "install-skills.js");
  const ci = process.env.CI && process.env.CI !== "false" && process.env.CI !== "0";
  if (ci) {
    console.log("ADIT user setup skipped in CI; run 'adit update' in your user session to install Skills and start the service.");
  } else if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
    // npm hides successful lifecycle output by default. A nonzero result keeps
    // incomplete user setup visible instead of silently accepting a root install.
    console.error("ADIT setup incomplete: do not install user Skills or start the service as root. Install ADIT without sudo from your regular account, using a writable npm global directory.");
    process.exitCode = 1;
  } else if (!existsSync(entry)) {
    // Workspace postinstall precedes the first build; published packages must
    // always contain their setup entry.
    if (!source) {
      console.error("ADIT setup incomplete: the package is missing its installer. Reinstall ADIT.");
      process.exitCode = 1;
    }
  } else {
    const result = spawnSync(process.execPath, [entry, ...(source ? ["--skills-only"] : ["--open-browser"])], {
      stdio: "inherit", env: process.env, windowsHide: true,
    });
    if (result.error) console.error(`ADIT setup incomplete: ${result.error.message}`);
    process.exitCode = result.error ? 1 : result.status ?? 1;
  }
}
