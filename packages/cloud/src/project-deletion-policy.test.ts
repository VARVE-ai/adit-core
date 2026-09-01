import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadConfig,
  readProjectManifest,
  writeProjectManifest,
  type ProjectManifest,
} from "@varveai/adit-core";
import {
  applyProjectDeletionPolicy,
  CloudProjectDeletedError,
} from "./project-deletion-policy.js";

describe("applyProjectDeletionPolicy", () => {
  let root: string;
  let manifest: ProjectManifest;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adit-deletion-policy-"));
    manifest = {
      schemaVersion: 1,
      projectId: "project-local-1",
      projectType: "workspace",
      repositories: [
        { relativePath: "api", repositoryId: "repository-api" },
        { relativePath: "web", repositoryId: "repository-web" },
      ],
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    };
    writeProjectManifest(root, manifest);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("marks one workspace repository while retaining its manifest entry", async () => {
    await applyProjectDeletionPolicy(root, {
      localProjectId: manifest.projectId,
      projectDeleted: false,
      deletionOperationId: null,
      deletedAt: null,
      deletedRepositories: [{
        deletionOperationId: "operation-api",
        localRepositoryId: "repository-api",
        relativePath: "api",
        deletedAt: "2026-08-31T10:00:00.000Z",
      }],
    });

    const updated = readProjectManifest(root)!;
    expect(updated.repositories).toHaveLength(2);
    expect(updated.repositories[0].cloudDeletionOperationId).toBe("operation-api");
    expect(loadConfig(root).repositories.map((repo) => repo.relativePath)).toEqual(["web"]);
  });

  it("blocks every repository after a whole Workspace deletion", async () => {
    await applyProjectDeletionPolicy(root, {
      localProjectId: manifest.projectId,
      projectDeleted: true,
      deletionOperationId: "operation-workspace",
      deletedAt: "2026-08-31T11:00:00.000Z",
      deletedRepositories: [],
    });

    const config = loadConfig(root);
    expect(config.cloudDeletedAt).toBe("2026-08-31T11:00:00.000Z");
    expect(config.repositories).toEqual([]);
  });

  it("does not apply an old tombstone to a recreated repository with a new ID", async () => {
    manifest.repositories[0] = {
      relativePath: "api",
      repositoryId: "repository-api-new",
      repositoryUrl: "https://example.com/api.git",
    };
    writeProjectManifest(root, manifest);

    await applyProjectDeletionPolicy(root, {
      localProjectId: manifest.projectId,
      projectDeleted: false,
      deletionOperationId: null,
      deletedAt: null,
      deletedRepositories: [{
        deletionOperationId: "operation-api-old",
        localRepositoryId: "repository-api-old",
        relativePath: "api",
        deletedAt: "2026-08-31T10:00:00.000Z",
      }],
    });

    expect(readProjectManifest(root)!.repositories[0]).toEqual(manifest.repositories[0]);
  });
});

describe("CloudProjectDeletedError", () => {
  it("explains how to create a new identity instead of implying a permanent block", () => {
    expect(new CloudProjectDeletedError(null).message).toBe(
      "This project identity was deleted from ADIT Cloud. Run 'adit init' to create a new project identity before linking again.",
    );
  });
});
