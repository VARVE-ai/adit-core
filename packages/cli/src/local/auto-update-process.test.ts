import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { runUpdateCommand, updateEnvironment, type UpdateRequest } from "./auto-update-process.js";

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "adit-update-process-test-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("runs the copied release helper outside the package without sibling dependencies", async () => {
  const directory = temporary();
  const script = join(directory, "updater.mjs");
  copyFileSync(new URL("../../dist/local/auto-update-process.js", import.meta.url), script);
  const request: UpdateRequest = {
    id: "smoke-test",
    version: "invalid-version-never-install",
    directory,
    resultPath: join(directory, "result.json"),
    installation: {
      entry: join(directory, "missing", "dist", "index.js"),
      root: join(directory, "missing"),
      manager: "npm",
    },
  };
  const config = join(directory, "request.json");
  writeFileSync(config, JSON.stringify(request));
  await expect(
    promisify(execFile)(process.execPath, [script, config], { windowsHide: true, timeout: 10_000 }),
  ).rejects.toMatchObject({ code: 1 });
  expect(JSON.parse(readFileSync(request.resultPath, "utf8"))).toMatchObject({
    id: request.id,
    error: "Automatic updates require a stable release",
  });
  expect(existsSync(request.installation.root)).toBe(false);
});

it("runs a child without a console or package install and reports a nonzero exit", async () => {
  const directory = temporary();
  await expect(
    runUpdateCommand(process.execPath, ["-e", "process.exit(0)"], process.env, directory),
  ).resolves.toBeUndefined();
  await expect(
    runUpdateCommand(process.execPath, ["-e", "process.exit(7)"], process.env, directory),
  ).rejects.toThrow("exit 7");
});

it("finds the package manager alongside Node under a minimal login environment", () => {
  const env = updateEnvironment({ PATH: "", ADIT_DISABLE_AUTO_UPDATE: "1" });
  expect(env.PATH).toContain(dirname(process.execPath));
  expect(env.ADIT_DISABLE_AUTO_UPDATE).toBe("1");
});
