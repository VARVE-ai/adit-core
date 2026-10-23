import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

// Test modules must never inherit the user's active local database, including
// after vi.unstubAllEnvs() restores a test's environment overrides.
const parent = resolve(tmpdir());
const directory = mkdtempSync(join(parent, "adit-vitest-data-"));
const previous = process.env.ADIT_LOCAL_DATA_DIR;
process.env.ADIT_LOCAL_DATA_DIR = directory;
afterAll(() => {
  if (previous === undefined) delete process.env.ADIT_LOCAL_DATA_DIR;
  else process.env.ADIT_LOCAL_DATA_DIR = previous;
  if (dirname(resolve(directory)) !== parent) throw new Error("Unsafe test cleanup path");
  rmSync(directory, { recursive: true, force: true });
});
