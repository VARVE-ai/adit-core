import { afterEach, describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: mocks.execFileSync }));
import { installUpgradedTaskSkill } from "./self-update.js";
afterEach(() => { vi.restoreAllMocks(); mocks.execFileSync.mockReset(); });

describe("upgraded skill installation", () => {
  it("runs the freshly installed script instead of the old in-memory template", () => {
    installUpgradedTaskSkill();
    expect(mocks.execFileSync).toHaveBeenCalledWith(process.execPath, [resolve(dirname(realpathSync(process.argv[1])), "install-skills.js")], { stdio: "inherit", env: process.env });
  });
  it("reports installation failures without pretending the skill was installed", () => {
    mocks.execFileSync.mockImplementation(() => { throw new Error("denied"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => installUpgradedTaskSkill()).not.toThrow();
    expect(warning).toHaveBeenCalled();
  });
});
