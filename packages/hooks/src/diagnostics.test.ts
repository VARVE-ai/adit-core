import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { AditConfig } from "@varveai/adit-core";

vi.mock("@varveai/adit-core", async (original) => ({
  ...(await original<object>()),
  readProjectManifest: () => null,
  readAgentRuntimeVersions: () => [],
}));
vi.mock("@varveai/adit-engine", () => ({
  getRemoteUrl: async () => "https://secret:token@example.com/project",
}));
vi.mock("./adapters/index.js", () => ({
  listAdapters: () => [
    {
      platform: "codex",
      displayName: "Codex",
      hookMappings: [{}],
      hasProjectHooks: async () => true,
      validateInstallation: async () => ({
        valid: true,
        checks: [{ ok: true, name: "Hooks" }],
      }),
    },
  ],
}));

import { collectRuntimeReport } from "./diagnostics.js";

it("collects read-only diagnostics without persisting platform backfills or leaking paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-diagnostics-"));
  const dataDir = join(root, ".adit");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "adit.sqlite"), "fixture");
  const config = {
    projectRoot: root,
    projectId: "qa",
    dataDir,
    dbPath: join(dataDir, "adit.sqlite"),
    repositories: [],
  } as unknown as AditConfig;
  const db = {
    prepare: () => ({ get: () => ({}) }),
    pragma: () => [{ quick_check: "ok" }],
  };
  try {
    const report = await collectRuntimeReport(
      config,
      db as never,
      "cli",
      "1.2.0",
    );
    expect(report.version).toBe("1.2.0");
    expect(
      report.components.find((item) => item.name === "cli")?.evidence,
    ).toBe("running");
    expect(
      report.components.find((item) => item.name === "hooks")?.evidence,
    ).toBe("installed");
    expect(report.platforms).toEqual(["codex"]);
    expect(readdirSync(dataDir)).toEqual(["adit.sqlite"]);
    expect(readFileSync(config.dbPath, "utf8")).toBe("fixture");
    expect(JSON.stringify(report)).not.toContain(root);
    expect(JSON.stringify(report)).not.toContain("secret");
    const failed = await collectRuntimeReport(
      config,
      {
        ...db,
        pragma: () => {
          throw new Error("corrupt");
        },
      } as never,
      "hooks",
    );
    expect(
      failed.checks.find((item) => item.name === "SQLite integrity")?.ok,
    ).toBeNull();
    expect(
      failed.components.find((item) => item.name === "hooks")?.evidence,
    ).toBe("running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
