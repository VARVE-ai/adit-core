const { copyFileSync, readFileSync, writeFileSync } = require("node:fs");
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
    // npm displays the README outside the repository, so resolve repository assets there.
    const readme = readFileSync(path.join(root, "README.md"), "utf8")
      .replaceAll('src="docs/images/', 'src="https://raw.githubusercontent.com/VARVE-ai/adit-core/main/docs/images/')
      .replaceAll("](docs/releasing.md)", "](https://github.com/VARVE-ai/adit-core/blob/main/docs/releasing.md)");
    writeFileSync(path.join(directory, "README.md"), readme);
    for (const file of ["SECURITY.md", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt"]) {
      copyFileSync(path.join(root, file), path.join(directory, file));
    }
  }
}
