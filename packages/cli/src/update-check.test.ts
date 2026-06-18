import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  formatUpdateWarning,
  maybeWarnForUpdate,
} from "./update-check.js";

describe("update check", () => {
  let tempDir: string;
  let cachePath: string;
  let writes: string[];
  let stderr: { write(text: string): boolean };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "adit-update-check-"));
    cachePath = join(tempDir, "version-check.json");
    writes = [];
    stderr = {
      write: (text: string) => {
        writes.push(text);
        return true;
      },
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("warns to stderr and writes the latest version to cache", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "1.2.3" }),
    }));

    await maybeWarnForUpdate({
      cachePath,
      commandId: "status",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000,
      stderr,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes.join("")).toContain(
      "A new version of ADIT is available: 1.0.0 -> 1.2.3",
    );
    expect(writes.join("")).toContain("Run: adit upgrade");
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({
      checkedAt: 1000,
      latestVersion: "1.2.3",
    });
  });

  it("uses a fresh cache instead of checking the network again", async () => {
    mkdirSync(join(tempDir), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ checkedAt: 1000, latestVersion: "1.2.0" }),
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not fetch");
    });

    await maybeWarnForUpdate({
      cachePath,
      commandId: "cloud.sync",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000 + 60 * 1000,
      stderr,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("1.0.0 -> 1.2.0");
  });

  it("fails open when the version request fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    await maybeWarnForUpdate({
      cachePath,
      commandId: "cloud.link",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000,
      stderr,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("skips checks when disabled, in CI, or for non-whitelisted commands", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "1.2.3" }),
    }));

    await maybeWarnForUpdate({
      cachePath,
      commandId: "status",
      currentVersion: "1.0.0",
      env: { ADIT_NO_UPDATE_CHECK: "1" },
      fetchImpl,
      now: 1000,
      stderr,
    });
    await maybeWarnForUpdate({
      cachePath,
      commandId: "status",
      currentVersion: "1.0.0",
      env: { CI: "true" },
      fetchImpl,
      now: 1000,
      stderr,
    });
    await maybeWarnForUpdate({
      cachePath,
      commandId: "timeline",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000,
      stderr,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("keeps JSON mode warnings on stderr without a leading blank line", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "1.2.3" }),
    }));

    await maybeWarnForUpdate({
      cachePath,
      commandId: "cloud.status",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      json: true,
      now: 1000,
      stderr,
    });

    expect(writes.join("")).toMatch(/^A new version of ADIT is available/);
  });

  it("compares semantic versions", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.3.0", "1.2.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
    expect(compareVersions("not-a-version", "1.2.3")).toBe(0);
  });

  it("formats human warnings with a leading blank line by default", () => {
    expect(formatUpdateWarning("1.0.0", "1.2.0")).toBe(
      "\nA new version of ADIT is available: 1.0.0 -> 1.2.0\nRun: adit upgrade\n\n",
    );
  });

  it("formats colored TTY warnings", () => {
    const warning = formatUpdateWarning("1.0.0", "1.2.0", false, true);

    expect(warning).toContain("\x1B[");
    expect(warning).toContain("adit upgrade");
    expect(warning.endsWith("\n\n")).toBe(true);
  });
});
