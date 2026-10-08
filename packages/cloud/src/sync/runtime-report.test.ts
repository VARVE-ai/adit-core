import { describe, expect, it } from "vitest";
import { formatUpgradeNotice, type UpgradeNotice } from "./runtime-report.js";

const notice: UpgradeNotice = {
  needsAttention: true,
  state: "important",
  currentVersion: "1.0.0",
  latest: {
    version: "1.2.0",
    summary: "Improve model capture",
    upgradeInstructions: "adit upgrade\nadit cloud sync",
  },
  impacts: [{ fixedIn: "1.2.0", description: "Model names may be missing.\nToken totals may be incomplete." }],
};

describe("formatUpgradeNotice", () => {
  it("prints the English text from Cloud without structured feature fields", () => {
    expect(formatUpgradeNotice(notice)).toBe([
      "ADIT upgrade: 1.0.0 -> 1.2.0 (important)",
      "Improve model capture",
      "Model names may be missing.\nToken totals may be incomplete.",
      "adit upgrade\nadit cloud sync",
      "Run 'adit upgrade', then 'adit cloud sync' to confirm the upgrade.",
    ].join("\n"));
  });
  it("handles empty impacts and hides notices when no upgrade is needed", () => {
    expect(formatUpgradeNotice({ ...notice, impacts: [] })).not.toContain("undefined");
    expect(formatUpgradeNotice({ ...notice, needsAttention: false })).toBeNull();
    expect(formatUpgradeNotice({ ...notice, latest: null })).toBeNull();
  });
});
