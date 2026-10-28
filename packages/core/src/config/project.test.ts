import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANIFEST_SCHEMA_VERSION,
  ProjectInitLockError,
  ProjectManifestError,
  computeLocalRepositoryId,
  deriveProjectType,
  discoverWorkspaceRepositories,
  findProjectManifestRoot,
  generateProjectId,
  projectManifestPath,
  readProjectManifest,
  resolveActiveManifestRepositories,
  resolveManifestRepositories,
  withProjectInitLock,
  writeProjectManifest,
  type ProjectManifest,
} from "./project.js";
import { loadConfig } from "./index.js";

const ENV_KEYS = ["ADIT_PROJECT_ROOT", "ADIT_DATA_DIR", "ADIT_DB_PATH", "ADIT_REMOTE_URL"] as const;

function manifestFor(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  const now = new Date().toISOString();
  const manifest: ProjectManifest = {
    schemaVersion: 1,
    projectId: "11111111-2222-4333-8444-555555555555",
    projectType: "repo",
    repositories: [{ relativePath: "." }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  if (manifest.projectType === undefined) delete manifest.projectType;
  return manifest;
}

describe("project manifest", () => {
  let root: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adit-manifest-"));
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("round-trips a single-repo manifest", () => {
    const manifest = manifestFor();
    writeProjectManifest(root, manifest);

    const read = readProjectManifest(root);
    expect(read).toEqual(manifest);

    const repos = resolveManifestRepositories(root, read!);
    expect(repos).toHaveLength(1);
    expect(repos[0].relativePath).toBe(".");
    expect(repos[0].localRepositoryId).toBe(manifest.projectId);
  });

  it("round-trips a workspace manifest with the frozen repository ID formula", () => {
    const manifest = manifestFor({
      projectType: "workspace",
      repositories: [{ relativePath: "api" }, { relativePath: "web" }],
    });
    writeProjectManifest(root, manifest);

    const repos = resolveManifestRepositories(root, readProjectManifest(root)!);
    expect(repos.map((repo) => repo.relativePath)).toEqual(["api", "web"]);
    expect(repos[0].localRepositoryId).toBe(computeLocalRepositoryId(manifest.projectId, "api"));
    expect(repos[0].path).toBe(join(root, "api"));
  });

  it("uses the stored repositoryId instead of re-deriving it from the path", () => {
    const manifest = manifestFor({
      projectType: "workspace",
      repositories: [
        { relativePath: "renamed-api", repositoryId: "persisted-id-1", repositoryUrl: "https://example.com/api.git" },
      ],
    });
    writeProjectManifest(root, manifest);

    const repos = resolveManifestRepositories(root, readProjectManifest(root)!);
    expect(repos[0].localRepositoryId).toBe("persisted-id-1");
    expect(repos[0].localRepositoryId).not.toBe(
      computeLocalRepositoryId(manifest.projectId, "renamed-api"),
    );
  });

  it("round-trips repository identity and recorded remote hints", () => {
    const manifest = manifestFor({
      projectType: "workspace",
      repositories: [
        { relativePath: "api", repositoryId: "id-a", repositoryUrl: "https://example.com/a.git" },
        { relativePath: "web", repositoryId: "id-b" },
      ],
    });
    writeProjectManifest(root, manifest);
    expect(readProjectManifest(root)).toEqual(manifest);
  });

  it("filters local-only and Cloud-deleted repositories without removing manifest entries", () => {
    const manifest = manifestFor({
      projectType: "workspace",
      repositories: [
        { relativePath: "api", repositoryId: "id-api", syncEnabled: false },
        {
          relativePath: "web",
          repositoryId: "id-web",
          cloudDeletedAt: "2026-08-31T10:00:00.000Z",
          cloudDeletionOperationId: "operation-1",
        },
        { relativePath: "worker", repositoryId: "id-worker" },
      ],
    });
    writeProjectManifest(root, manifest);

    const read = readProjectManifest(root)!;
    expect(read.repositories).toHaveLength(3);
    expect(resolveActiveManifestRepositories(root, read).map((repo) => repo.relativePath)).toEqual([
      "worker",
    ]);
  });

  it("rejects duplicate repositoryIds", () => {
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(
      projectManifestPath(root),
      JSON.stringify(
        manifestFor({
          projectType: "workspace",
          repositories: [
            { relativePath: "api", repositoryId: "same" },
            { relativePath: "web", repositoryId: "same" },
          ],
        }),
      ),
      "utf-8",
    );
    expect(() => readProjectManifest(root)).toThrow(/repositoryId/u);
  });

  it("returns null when no manifest exists", () => {
    expect(readProjectManifest(root)).toBeNull();
  });

  it("throws on corrupt JSON without minting a new identity", () => {
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(projectManifestPath(root), "{bad", "utf-8");
    expect(() => readProjectManifest(root)).toThrow(ProjectManifestError);
  });

  it("throws on an unsupported schemaVersion", () => {
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(
      projectManifestPath(root),
      JSON.stringify({ ...manifestFor(), schemaVersion: 99 }),
      "utf-8",
    );
    expect(() => readProjectManifest(root)).toThrow(/schemaVersion/u);
  });

  it.each([
    ["absolute path", [{ relativePath: "/etc" }]],
    ["parent traversal", [{ relativePath: ".." }]],
    ["nested path", [{ relativePath: "a/b" }]],
    ["empty path", [{ relativePath: "" }]],
    ["duplicate path", [{ relativePath: "api" }, { relativePath: "api" }]],
  ])("rejects a workspace manifest with %s", (_label, repositories) => {
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(
      projectManifestPath(root),
      JSON.stringify(manifestFor({ projectType: "workspace", repositories })),
      "utf-8",
    );
    expect(() => readProjectManifest(root)).toThrow(ProjectManifestError);
  });

  it("reads and writes a schema 2 manifest without a project type", () => {
    const manifest: ProjectManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      projectId: "11111111-2222-4333-8444-555555555555",
      repositories: [{ relativePath: "." }, { relativePath: "api", repositoryId: "id-api" }],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    writeProjectManifest(root, manifest);

    const read = readProjectManifest(root)!;
    expect(read).toEqual(manifest);
    expect(read.projectType).toBeUndefined();
    expect(deriveProjectType(read)).toBe("workspace");
  });

  it("identifies the root entry by the project ID and members by their own identity in one manifest", () => {
    const manifest: ProjectManifest = {
      schemaVersion: 2,
      projectId: "11111111-2222-4333-8444-555555555555",
      repositories: [{ relativePath: "." }, { relativePath: "api" }, { relativePath: "web", repositoryId: "id-web" }],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    writeProjectManifest(root, manifest);

    const repos = resolveManifestRepositories(root, readProjectManifest(root)!);
    expect(repos.map((repo) => repo.localRepositoryId)).toEqual([
      manifest.projectId,
      computeLocalRepositoryId(manifest.projectId, "api"),
      "id-web",
    ]);
  });

  it("still reads a legacy schema 1 manifest and derives its type", () => {
    const legacy = manifestFor({ projectType: "workspace", repositories: [{ relativePath: "api" }] });
    writeProjectManifest(root, legacy);

    const read = readProjectManifest(root)!;
    expect(read.schemaVersion).toBe(1);
    expect(read.projectType).toBe("workspace");
    expect(deriveProjectType(read)).toBe("workspace");
    expect(deriveProjectType(manifestFor())).toBe("repo");
  });

  it("rejects a legacy manifest with an invalid project type", () => {
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(
      projectManifestPath(root),
      JSON.stringify({ ...manifestFor(), projectType: "monorepo" }),
      "utf-8",
    );
    expect(() => readProjectManifest(root)).toThrow(/projectType/u);
  });

  it("rejects a symlinked repository that escapes the project root", () => {
    const outside = mkdtempSync(join(tmpdir(), "adit-outside-"));
    try {
      symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
      const manifest = manifestFor({
        projectType: "workspace",
        repositories: [{ relativePath: "escape" }],
      });
      expect(() => resolveManifestRepositories(root, manifest)).toThrow(/outside the project root/u);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps missing repository directories as a soft condition", () => {
    const manifest = manifestFor({
      projectType: "workspace",
      repositories: [{ relativePath: "gone" }],
    });
    const repos = resolveManifestRepositories(root, manifest);
    expect(repos).toHaveLength(1);
    expect(existsSync(repos[0].path)).toBe(false);
  });

  it("finds the nearest manifest root from a nested plain directory", () => {
    writeProjectManifest(root, manifestFor());
    const nested = join(root, "docs", "deep");
    mkdirSync(nested, { recursive: true });
    expect(findProjectManifestRoot(nested)).toBe(root);
  });

  it("generates UUID project IDs", () => {
    expect(generateProjectId()).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("refuses a second concurrent init via the lock", async () => {
    await withProjectInitLock(root, async () => {
      await expect(withProjectInitLock(root, async () => "inner")).rejects.toBeInstanceOf(
        ProjectInitLockError,
      );
    });
    // released after the outer run completes
    await expect(withProjectInitLock(root, async () => "again")).resolves.toBe("again");
  });

  it("recovers a stale init lock", async () => {
    const lockPath = join(root, ".adit", "init.lock");
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(lockPath, "12345", "utf-8");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lockPath, old, old);

    await expect(withProjectInitLock(root, async () => "ok")).resolves.toBe("ok");
  });

  it("writes the manifest atomically without leaving temp files", () => {
    writeProjectManifest(root, manifestFor());
    writeProjectManifest(root, manifestFor({ updatedAt: new Date().toISOString() }));
    const entries = readFileSync(projectManifestPath(root), "utf-8");
    expect(JSON.parse(entries).schemaVersion).toBe(1);
  });

  it("recovers dead-process locks immediately and never steals a live long-running init", async () => {
    const lock = join(root, ".adit", "init.lock");
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(lock, "2147483647");
    await withProjectInitLock(root, async () => {});
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, String(process.pid));
    utimesSync(lock, new Date(0), new Date(0));
    await expect(withProjectInitLock(root, async () => {})).rejects.toThrow(ProjectInitLockError);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });
});

describe("discoverWorkspaceRepositories", () => {
  it("discovers only visible immediate child Git repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "adit-discover-"));
    try {
      mkdirSync(join(root, "api", ".git"), { recursive: true });
      mkdirSync(join(root, "web", ".git"), { recursive: true });
      mkdirSync(join(root, "nested", "worker", ".git"), { recursive: true });
      mkdirSync(join(root, ".hidden", ".git"), { recursive: true });
      mkdirSync(join(root, "plain"), { recursive: true });

      expect(discoverWorkspaceRepositories(root).map((repo) => repo.relativePath)).toEqual([
        "api",
        "web",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
