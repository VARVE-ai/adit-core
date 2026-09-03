import { describe, expect, it } from "vitest";
import {
  buildGlobalUpgradeCommand,
  detectGlobalPackageManager,
} from "./self-update.js";

describe("detectGlobalPackageManager", () => {
  it("recognizes each package manager's global install location", () => {
    expect(detectGlobalPackageManager("/Users/me/.bun/install/global/node_modules/@varveai/adit-cli/dist/index.js")).toBe("bun");
    expect(detectGlobalPackageManager("/Users/me/Library/pnpm/global/5/node_modules/@varveai/adit-cli/dist/index.js")).toBe("pnpm");
    expect(detectGlobalPackageManager("/Users/me/.config/yarn/global/node_modules/@varveai/adit-cli/dist/index.js")).toBe("yarn");
    expect(detectGlobalPackageManager("/usr/local/lib/node_modules/@varveai/adit-cli/dist/index.js")).toBe("npm");
    expect(detectGlobalPackageManager("C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@varveai\\adit-cli\\dist\\index.js")).toBe("pnpm");
  });

  it("falls back to npm when the path is unknown or empty", () => {
    expect(detectGlobalPackageManager("")).toBe("npm");
    expect(detectGlobalPackageManager("/opt/tools/adit/index.js")).toBe("npm");
  });
});

describe("buildGlobalUpgradeCommand", () => {
  it("pins the resolved version for every package manager", () => {
    expect(buildGlobalUpgradeCommand("npm", "1.4.0")).toBe("npm install -g @varveai/adit-cli@1.4.0");
    expect(buildGlobalUpgradeCommand("pnpm", "1.4.0")).toBe("pnpm add -g @varveai/adit-cli@1.4.0");
    expect(buildGlobalUpgradeCommand("yarn", "1.4.0")).toBe("yarn global add @varveai/adit-cli@1.4.0");
    expect(buildGlobalUpgradeCommand("bun", "1.4.0")).toBe("bun add -g @varveai/adit-cli@1.4.0");
  });

  it("defaults to the latest tag", () => {
    expect(buildGlobalUpgradeCommand("npm")).toBe("npm install -g @varveai/adit-cli@latest");
  });
});
