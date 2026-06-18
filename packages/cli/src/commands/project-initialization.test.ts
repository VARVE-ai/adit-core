import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatAditProjectNotInitializedMessage,
  getAditProjectInitializationStatus,
  isAditProjectInitialized,
} from "./project-initialization.js";

describe("ADIT project initialization checks", () => {
  let projectRoot: string;
  let originalAditDataDir: string | undefined;
  let originalAditDbPath: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "adit-project-init-"));
    originalAditDataDir = process.env.ADIT_DATA_DIR;
    originalAditDbPath = process.env.ADIT_DB_PATH;
    delete process.env.ADIT_DATA_DIR;
    delete process.env.ADIT_DB_PATH;
  });

  afterEach(() => {
    if (originalAditDataDir === undefined) {
      delete process.env.ADIT_DATA_DIR;
    } else {
      process.env.ADIT_DATA_DIR = originalAditDataDir;
    }
    if (originalAditDbPath === undefined) {
      delete process.env.ADIT_DB_PATH;
    } else {
      process.env.ADIT_DB_PATH = originalAditDbPath;
    }
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("requires both the ADIT data directory and database", () => {
    expect(isAditProjectInitialized(projectRoot)).toBe(false);

    mkdirSync(join(projectRoot, ".adit"));
    expect(isAditProjectInitialized(projectRoot)).toBe(false);

    writeFileSync(join(projectRoot, ".adit", "adit.sqlite"), "");
    expect(isAditProjectInitialized(projectRoot)).toBe(true);
  });

  it("honors explicit ADIT data and database paths without creating files", () => {
    const dataDir = join(projectRoot, "custom-adit");
    const dbPath = join(projectRoot, "custom.sqlite");
    process.env.ADIT_DATA_DIR = dataDir;
    process.env.ADIT_DB_PATH = dbPath;

    const missing = getAditProjectInitializationStatus(projectRoot);
    expect(missing).toMatchObject({
      dataDir,
      dbPath,
      dataDirExists: false,
      dbExists: false,
      initialized: false,
    });

    mkdirSync(dataDir);
    writeFileSync(dbPath, "");

    expect(getAditProjectInitializationStatus(projectRoot)).toMatchObject({
      dataDirExists: true,
      dbExists: true,
      initialized: true,
    });
  });

  it("formats a no-side-effect recovery message", () => {
    expect(formatAditProjectNotInitializedMessage("adit cloud claude")).toBe([
      "ADIT is not initialized in this project.",
      "",
      "Run:",
      "  adit init",
      "",
      "Then retry:",
      "  adit cloud claude",
    ].join("\n"));
  });
});
