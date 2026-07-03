import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverWorkspaceRepositories,
  ensureWorkspaceManifest,
  findWorkspaceRoot,
  computeRepoProjectId,
  readWorkspaceManifest,
} from "./project.js";
import { loadConfig } from "./index.js";

describe("workspace project discovery", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adit-workspace-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers only immediate child Git repositories", () => {
    mkdirSync(join(root, "api", ".git"), { recursive: true });
    mkdirSync(join(root, "web", ".git"), { recursive: true });
    mkdirSync(join(root, "nested", "worker", ".git"), { recursive: true });
    mkdirSync(join(root, ".hidden", ".git"), { recursive: true });

    expect(discoverWorkspaceRepositories(root).map((repo) => repo.relativePath)).toEqual([
      ".hidden",
      "api",
      "web",
    ]);
  });

  it("creates and finds a workspace manifest", () => {
    const manifest = ensureWorkspaceManifest(root);
    const child = join(root, "api");
    mkdirSync(child);

    expect(manifest.workspaceId).toHaveLength(16);
    expect(readWorkspaceManifest(root)?.workspaceId).toBe(manifest.workspaceId);
    expect(findWorkspaceRoot(child)).toBe(root);
  });

  it("ignores invalid workspace manifests", () => {
    mkdirSync(join(root, ".adit"), { recursive: true });
    writeFileSync(join(root, ".adit", "workspace.json"), "{bad", "utf-8");

    expect(readWorkspaceManifest(root)).toBeNull();
    expect(findWorkspaceRoot(root)).toBeNull();
  });

  it("loads a child Git repository as an independent repo project inside a workspace", () => {
    ensureWorkspaceManifest(root);
    const child = join(root, "adit-core");
    mkdirSync(join(child, ".git"), { recursive: true });
    mkdirSync(join(child, ".adit"), { recursive: true });
    writeFileSync(join(child, ".adit", "adit.sqlite"), "", "utf-8");

    const config = loadConfig(child);

    expect(config.projectType).toBe("repo");
    expect(config.projectRoot).toBe(child);
    expect(config.projectId).toBe(computeRepoProjectId(child));
    expect(config.repositories).toMatchObject([{
      localRepositoryId: config.projectId,
      relativePath: ".",
      displayName: "adit-core",
      path: child,
    }]);
  });

  it("loads an uninitialized child Git repository as its own repo candidate", () => {
    ensureWorkspaceManifest(root);
    const child = join(root, "api");
    mkdirSync(join(child, ".git"), { recursive: true });

    const config = loadConfig(child);

    expect(config.projectType).toBe("repo");
    expect(config.projectRoot).toBe(child);
    expect(config.projectId).toBe(computeRepoProjectId(child));
    expect(config.repositories).toMatchObject([{
      localRepositoryId: config.projectId,
      relativePath: ".",
      displayName: "api",
      path: child,
    }]);
  });

  it("loads a non-Git child directory as its own repo candidate instead of the parent workspace", () => {
    ensureWorkspaceManifest(root);
    const child = join(root, "scratch");
    mkdirSync(child, { recursive: true });
    mkdirSync(join(root, "api", ".git"), { recursive: true });

    const config = loadConfig(child);

    expect(config.projectType).toBe("repo");
    expect(config.projectRoot).toBe(child);
    expect(config.projectId).toBe(computeRepoProjectId(child));
    expect(config.repositories).toMatchObject([{
      localRepositoryId: config.projectId,
      relativePath: ".",
      displayName: "scratch",
      path: child,
    }]);
  });
});
