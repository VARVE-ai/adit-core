import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeProjectManifest, type ProjectManifest } from "@varveai/adit-core";
import {
  classifyProjectGuardState,
  loadInitializedProjectConfig,
} from "./project-initialization.js";

const ENV_KEYS = ["ADIT_PROJECT_ROOT", "ADIT_DATA_DIR", "ADIT_DB_PATH"] as const;

function manifestFor(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    projectId: "11111111-2222-4333-8444-555555555555",
    projectType: "repo",
    repositories: [{ relativePath: "." }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("project initialization guard", () => {
  let projectRoot: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "adit-guard-"));
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.exitCode = undefined;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("returns the config for an initialized project", () => {
    writeProjectManifest(projectRoot, manifestFor());
    writeFileSync(join(projectRoot, ".adit", "adit.sqlite"), "", "utf-8");

    const config = loadInitializedProjectConfig("adit status", projectRoot);
    expect(config).not.toBeNull();
    expect(config!.projectId).toBe(manifestFor().projectId);
    expect(process.exitCode).toBeUndefined();
  });

  it("stops with the not-initialized message for a fresh directory", () => {
    const config = loadInitializedProjectConfig("adit status", projectRoot);
    expect(config).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("not initialized");
  });

  it("stops with the migration message for a legacy project", () => {
    mkdirSync(join(projectRoot, ".adit"), { recursive: true });
    writeFileSync(join(projectRoot, ".adit", "adit.sqlite"), "", "utf-8");

    const config = loadInitializedProjectConfig("adit status", projectRoot);
    expect(config).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("migration");
  });

  it("stops with the repair message when the manifest exists but the database is missing", () => {
    writeProjectManifest(projectRoot, manifestFor());

    const config = loadInitializedProjectConfig("adit status", projectRoot);
    expect(config).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("database is missing");
  });

  it("stops with the corrupt message when the manifest is damaged", () => {
    mkdirSync(join(projectRoot, ".adit"), { recursive: true });
    writeFileSync(join(projectRoot, ".adit", "project.json"), "{bad", "utf-8");

    const config = loadInitializedProjectConfig("adit status", projectRoot);
    expect(config).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("damaged");
  });

  it("routes a registered member repository to its parent project", () => {
    // parent container with a manifest listing this repository
    const parent = mkdtempSync(join(tmpdir(), "adit-parent-"));
    try {
      const child = join(parent, "api");
      mkdirSync(join(child, ".git"), { recursive: true });
      writeProjectManifest(
        parent,
        manifestFor({ projectType: "workspace", repositories: [{ relativePath: "api" }] }),
      );
      writeFileSync(join(parent, ".adit", "adit.sqlite"), "", "utf-8");

      const config = loadInitializedProjectConfig("adit status", child);
      expect(config).not.toBeNull();
      expect(config!.projectRoot).toBe(parent);
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not pass through to a parent project from an unregistered repository", () => {
    const parent = mkdtempSync(join(tmpdir(), "adit-parent-"));
    try {
      const child = join(parent, "web");
      mkdirSync(join(child, ".git"), { recursive: true });
      writeProjectManifest(
        parent,
        manifestFor({ projectType: "workspace", repositories: [{ relativePath: "api" }] }),
      );

      const config = loadInitializedProjectConfig("adit status", child);
      expect(config).toBeNull();
      expect(process.exitCode).toBe(1);
      expect(vi.mocked(console.error).mock.calls[0][0]).toContain("not initialized");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("classifies guard states from a loaded config", () => {
    writeProjectManifest(projectRoot, manifestFor());
    writeFileSync(join(projectRoot, ".adit", "adit.sqlite"), "", "utf-8");

    const config = loadInitializedProjectConfig("adit status", projectRoot);
    expect(classifyProjectGuardState(config!)).toBe("initialized");
  });
});
