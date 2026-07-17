/**
 * Verifies npm install preflight behavior for native SQLite binary coverage.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(testDir, "../../scripts/check-native-install.js");

describe("native install preflight", () => {
  it("stays quiet when a known better-sqlite3 prebuild exists", () => {
    const result = runCheck({
      ADIT_NATIVE_CHECK_BETTER_SQLITE3_VERSION: "12.10.0",
      ADIT_NATIVE_CHECK_PLATFORM: "darwin",
      ADIT_NATIVE_CHECK_ARCH: "arm64",
      ADIT_NATIVE_CHECK_MODULES: "147",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails with guidance when native compilation is likely", () => {
    const result = runCheck({
      ADIT_NATIVE_CHECK_BETTER_SQLITE3_VERSION: "12.10.0",
      ADIT_NATIVE_CHECK_PLATFORM: "win32",
      ADIT_NATIVE_CHECK_ARCH: "x64",
      ADIT_NATIVE_CHECK_MODULES: "115",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Installation stopped: no compatible SQLite binary");
    expect(result.stderr).toContain("Your project is fine");
    expect(result.stderr).toContain("Fastest fix (recommended)");
    expect(result.stderr).toContain("Node.js 22, 24, 25, or 26");
    expect(result.stderr).toContain("better-sqlite3@12.10.0");
    expect(result.stderr).toContain("Node.js 20 | win32-x64 | ABI 115");
    expect(result.stderr).toContain("$env:ADIT_ALLOW_NATIVE_BUILD=\"1\"");
    expect(result.stderr).toContain("does not make an incompatible native dependency work");
  });

  it("allows users to explicitly continue with a native build", () => {
    const result = runCheck({
      ADIT_ALLOW_NATIVE_BUILD: "1",
      ADIT_NATIVE_CHECK_BETTER_SQLITE3_VERSION: "12.10.0",
      ADIT_NATIVE_CHECK_PLATFORM: "win32",
      ADIT_NATIVE_CHECK_ARCH: "x64",
      ADIT_NATIVE_CHECK_MODULES: "115",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails when better-sqlite3 is not pinned to an exact version", () => {
    const result = runCheck({
      ADIT_NATIVE_CHECK_BETTER_SQLITE3_VERSION: "^12.10.0",
      ADIT_NATIVE_CHECK_PLATFORM: "win32",
      ADIT_NATIVE_CHECK_ARCH: "x64",
      ADIT_NATIVE_CHECK_MODULES: "115",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("non-exact better-sqlite3 dependency");
    expect(result.stderr).toContain("^12.10.0");
  });
});

function runCheck(overrides: Record<string, string>) {
  const env = { ...process.env, ...overrides };
  delete env.ADIT_ALLOW_NATIVE_BUILD;
  delete env.ADIT_SKIP_NATIVE_PREBUILD_CHECK;

  if (overrides.ADIT_ALLOW_NATIVE_BUILD !== undefined) {
    env.ADIT_ALLOW_NATIVE_BUILD = overrides.ADIT_ALLOW_NATIVE_BUILD;
  }

  return spawnSync(process.execPath, [scriptPath], {
    env,
    encoding: "utf8",
  });
}
