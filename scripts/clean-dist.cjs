// Run only from the source workspace. Resolve and check every target before removal.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
for (const name of ["core", "engine", "cloud", "cli"]) {
  fs.rmSync(path.join(root, "packages", name, "tsconfig.tsbuildinfo"), { force: true });
  const target = path.resolve(root, "packages", name, "dist");
  if (path.dirname(target) !== path.join(root, "packages", name)) throw new Error("Invalid build path");
  if (!fs.existsSync(target)) continue;
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Refusing to clean linked build output");
  fs.rmSync(target, { recursive: true, force: true });
}
