const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const entry = join(__dirname, "dist", "install-skills.js");
if (existsSync(entry)) {
  import(pathToFileURL(entry).href).catch((error) => console.warn("ADIT skill installation failed. Run adit init to retry:", error.message));
}
