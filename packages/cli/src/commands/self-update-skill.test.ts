import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
const mocks = vi.hoisted(() => ({ execFileSync: vi.fn(), execSync: vi.fn(), latest: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: mocks.execFileSync, execSync: mocks.execSync }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: () => false }));
vi.mock("../update-check.js", async (original) => ({ ...await original<typeof import("../update-check.js")>(), fetchLatestPublishedVersion: mocks.latest }));
import { completeUpgradedInstallation, selfUpdateCommand } from "./self-update.js";
import { CLI_VERSION } from "../version.js";
const originalExitCode = process.exitCode;
beforeEach(() => { process.exitCode = undefined; mocks.latest.mockResolvedValue("999.0.0"); vi.spyOn(console,"log").mockImplementation(() => {}); vi.spyOn(console,"error").mockImplementation(() => {}); });
afterEach(() => { process.exitCode = originalExitCode; vi.restoreAllMocks(); vi.unstubAllEnvs(); mocks.execFileSync.mockReset(); mocks.execSync.mockReset(); });

describe("upgraded skill installation", () => {
  it("runs the freshly installed script instead of the old in-memory template", () => {
    expect(completeUpgradedInstallation()).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledWith(process.execPath, [resolve(dirname(realpathSync(process.argv[1])), "install-skills.js"), "--open-browser"], { stdio: "inherit", env: process.env });
  });
  it("reports installation failures without pretending the skill was installed", () => {
    mocks.execFileSync.mockImplementation(() => { throw new Error("denied"); });
    expect(completeUpgradedInstallation()).toBe(false);
    expect(console.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it("defers package hooks and finishes once, before reporting upgrade success", async () => {
    await selfUpdateCommand();
    expect(mocks.execSync).toHaveBeenCalledWith(expect.stringContaining("@varveai/adit-cli@999.0.0"), expect.objectContaining({ env: expect.objectContaining({ ADIT_DEFER_INSTALL_SETUP: "1" }) }));
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
    expect(mocks.execFileSync.mock.calls[0][1]).toEqual([expect.stringContaining("install-skills.js"),"--open-browser","--expected-version","999.0.0"]);
    expect(mocks.execSync.mock.invocationCallOrder[0]).toBeLessThan(mocks.execFileSync.mock.invocationCallOrder[0]);
    const success = vi.mocked(console.log).mock.calls.findIndex(args => String(args[0]).includes("Updated successfully"));
    expect(mocks.execFileSync.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(console.log).mock.invocationCallOrder[success]);
  });
  it("does not claim success when final setup fails", async () => {
    mocks.execFileSync.mockImplementation(() => { throw new Error("service failed"); });
    await selfUpdateCommand();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("Updated successfully");
  });
  it("retries setup and opens the workbench even on the latest version, but leaves --check read-only", async () => {
    mocks.latest.mockResolvedValue(CLI_VERSION);
    await selfUpdateCommand({ check: true });
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    await selfUpdateCommand();
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
    expect(mocks.execFileSync.mock.calls[0][1]).toEqual([expect.stringContaining("install-skills.js"), "--open-browser"]);
    expect(mocks.execSync).not.toHaveBeenCalled();
  });
  it("clears the internal deferral flag for the final setup process", () => {
    vi.stubEnv("ADIT_DEFER_INSTALL_SETUP", "1");
    completeUpgradedInstallation();
    expect(mocks.execFileSync.mock.calls[0][2].env.ADIT_DEFER_INSTALL_SETUP).toBeUndefined();
  });
});
