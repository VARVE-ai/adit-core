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
  formatCriticalUpdateBlock,
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

  function mockPolicyAndLatest(input: {
    currentVersion?: string;
    latestVersion: string;
  }) {
    return vi.fn(async (url: string) => {
      if (url.includes("/api/client-version-policy")) {
        return {
          ok: true,
          json: async () => ({
            decision: "ok",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ version: input.latestVersion }),
      };
    });
  }

  it("warns to stderr and writes the latest version to cache", async () => {
    const fetchImpl = mockPolicyAndLatest({ latestVersion: "1.2.3" });

    const blocked = await maybeWarnForUpdate({
      cachePath,
      commandId: "status",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000,
      stderr,
    });

    expect(blocked).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(writes.join("")).toBe("! Update available 1.0.0 → 1.2.3 · run adit update\n");
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({
      checkedAt: 1000,
      latestVersion: "1.2.3",
    });
  });

  it("blocks critical versions before running the command", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        decision: "block",
      }),
    }));

    const blocked = await maybeWarnForUpdate({
      cachePath,
      commandId: "cloud.sync",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000,
      stderr,
    });

    expect(blocked).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes.join("")).toContain("ADIT update required");
    expect(writes.join("")).toContain("version 1.0.0 is blocked");
    expect(writes.join("")).toContain("npm install -g @varveai/adit-cli@latest");
  });

  it("always checks policy while reusing the fresh npm cache", async () => {
    mkdirSync(join(tempDir), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        checkedAt: 1000,
        latestVersion: "1.2.0",
      }),
    );
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.includes("/api/client-version-policy")) {
        throw new Error("npm should use its cache");
      }
      return {
        ok: true,
        json: async () => ({ decision: "ok" }),
      };
    });

    await maybeWarnForUpdate({
      cachePath,
      commandId: "status",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000 + 60 * 1000,
      stderr,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes.join("")).toContain("1.0.0 → 1.2.0");
  });

  it("fails open when the version request fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    await maybeWarnForUpdate({
      cachePath,
      commandId: "doctor",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000,
      stderr,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(writes).toEqual([]);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("checks the policy but shows no notice outside init, status and doctor", async () => {
    const fetchImpl = mockPolicyAndLatest({ latestVersion: "1.2.3" });

    const blocked = await maybeWarnForUpdate({
      cachePath,
      commandId: "cloud.sync",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000,
      stderr,
    });

    expect(blocked).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it("hands the notice to the caller when asked to defer it", async () => {
    const fetchImpl = mockPolicyAndLatest({ latestVersion: "1.2.3" });
    const notices: string[] = [];

    await maybeWarnForUpdate({
      cachePath,
      commandId: "init",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      now: 1000,
      stderr,
      onNotice: (notice) => notices.push(notice),
    });

    expect(writes).toEqual([]);
    expect(notices).toEqual(["! Update available 1.0.0 → 1.2.3 · run adit update"]);
  });

  it("still checks blocking policy when ordinary update checks are disabled", async () => {
    const fetchImpl = mockPolicyAndLatest({ latestVersion: "1.2.3" });

    await maybeWarnForUpdate({
      cachePath,
      commandId: "status",
      currentVersion: "1.0.0",
      env: { ADIT_NO_UPDATE_CHECK: "1" },
      fetchImpl,
      now: 1000,
      stderr,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it("checks the cloud server stored with local credentials", async () => {
    const fetchImpl = mockPolicyAndLatest({ latestVersion: "1.2.3" });

    await maybeWarnForUpdate({
      cachePath,
      cloudServerUrl: "http://localhost:3000",
      commandId: "cloud.status",
      currentVersion: "1.0.0",
      env: { ADIT_NO_UPDATE_CHECK: "1" },
      fetchImpl,
      now: 1000,
      stderr,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/client-version-policy?version=1.0.0",
      expect.any(Object),
    );
    expect(existsSync(cachePath)).toBe(false);
  });

  it("does not cache blocking policy decisions", async () => {
    const fetchImpl = mockPolicyAndLatest({ latestVersion: "1.2.3" });

    for (const now of [1000, 1001]) {
      await maybeWarnForUpdate({
        cachePath,
        commandId: "status",
        currentVersion: "1.0.0",
        env: { ADIT_NO_UPDATE_CHECK: "1" },
        fetchImpl,
        now,
        stderr,
      });
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("still checks blocking policy in CI without ordinary update warnings", async () => {
    const fetchImpl = mockPolicyAndLatest({ latestVersion: "1.2.3" });

    await maybeWarnForUpdate({
      cachePath,
      commandId: "status",
      currentVersion: "1.0.0",
      env: { CI: "true" },
      fetchImpl,
      now: 1000,
      stderr,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it("skips checks for non-whitelisted commands", async () => {
    const fetchImpl = mockPolicyAndLatest({ latestVersion: "1.2.3" });

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
    const fetchImpl = mockPolicyAndLatest({ latestVersion: "1.2.3" });

    await maybeWarnForUpdate({
      cachePath,
      commandId: "status",
      currentVersion: "1.0.0",
      env: {},
      fetchImpl,
      json: true,
      now: 1000,
      stderr,
    });

    expect(writes.join("")).toMatch(/^! Update available/);
  });

  it("compares semantic versions", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.3.0", "1.2.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
    expect(compareVersions("not-a-version", "1.2.3")).toBe(0);
  });

  it("formats the notice as one line naming adit update", () => {
    expect(formatUpdateWarning("1.0.0", "1.2.0")).toBe(
      "! Update available 1.0.0 → 1.2.0 · run adit update",
    );
  });

  it("formats colored TTY warnings", () => {
    const warning = formatUpdateWarning("1.0.0", "1.2.0", true);

    expect(warning).toContain("\x1B[");
    expect(warning).toContain("adit update");
    expect(warning).not.toContain("\n");
  });

  it("formats critical update blocks with the npm install command", () => {
    expect(
      formatCriticalUpdateBlock({
        decision: "block",
        currentVersion: "1.0.0",
      }),
    ).toBe(
      "✗ ADIT update required: version 1.0.0 is blocked by adit-cloud policy\n" +
        "  run npm install -g @varveai/adit-cli@latest\n",
    );
  });
});
