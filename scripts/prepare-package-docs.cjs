const { copyFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const publicPackages = ["core", "engine", "cloud", "cli"];
const requestedPackages = process.argv.slice(2);
const packages = requestedPackages.length ? requestedPackages : publicPackages;

for (const name of packages) {
  if (!publicPackages.includes(name)) {
    throw new Error(`Unknown public package: ${name}`);
  }
  const directory = path.join(root, "packages", name);
  // Keep the repository documents as the only maintained copies.
  copyFileSync(path.join(root, "LICENSE"), path.join(directory, "LICENSE"));
  if (name === "cli") {
    copyFileSync(path.join(root, "README.md"), path.join(directory, "README.md"));
  }
}
