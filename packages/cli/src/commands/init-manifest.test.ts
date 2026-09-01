import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeLocalRepositoryId,
  readProjectManifest,
  writeProjectManifest,
  type ProjectManifest,
} from "@varveai/adit-core";
import type { ProjectLayoutAnalysis } from "./project-layout.js";

const promptAnswers = vi.hoisted(() => [] as string[]);
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: vi.fn(async () => promptAnswers.shift() ?? ""),
    close: vi.fn(),
  }),
}));

import {
  createReplacementProjectManifest,
  prepareProjectManifest,
} from "./init-manifest.js";

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

afterEach(() => {
  promptAnswers.length = 0;
  if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
  if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
});

describe("deleted project reinitialization", () => {
  it("creates a new project and repository identity without carrying deletion tombstones", () => {
    const existing: ProjectManifest = {
      schemaVersion: 1,
      projectId: "project-old",
      projectType: "workspace",
      repositories: [{
        relativePath: "api",
        repositoryId: "repository-old",
        repositoryUrl: "https://example.com/old.git",
        cloudDeletedAt: "2026-09-01T00:00:00.000Z",
        cloudDeletionOperationId: "operation-api",
      }],
      cloudDeletedAt: "2026-09-01T00:00:00.000Z",
      cloudDeletionOperationId: "operation-project",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const analysis: ProjectLayoutAnalysis = {
      root: {
        path: "/workspace",
        isGitRepository: false,
        hasHead: false,
        originUrl: null,
      },
      childRepositories: [{
        path: "/workspace/api",
        relativePath: "api",
        displayName: "api",
        originUrl: "https://example.com/new.git",
      }],
      recommendation: "multi-repo",
      requiresConfirmation: true,
    };

    const replacement = createReplacementProjectManifest(
      existing,
      analysis,
      "workspace",
      "project-new",
      "2026-09-01T01:00:00.000Z",
    );

    expect(replacement).toEqual({
      schemaVersion: 1,
      projectId: "project-new",
      projectType: "workspace",
      repositories: [{
        relativePath: "api",
        repositoryId: computeLocalRepositoryId("project-new", "api"),
        repositoryUrl: "https://example.com/new.git",
      }],
      createdAt: "2026-09-01T01:00:00.000Z",
      updatedAt: "2026-09-01T01:00:00.000Z",
    });
  });

  it("writes a fresh identity after interactive confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "adit-recreate-project-"));
    const childPath = join(root, "api");
    mkdirSync(join(childPath, ".git"), { recursive: true });
    const existing: ProjectManifest = {
      schemaVersion: 1,
      projectId: "project-old",
      projectType: "workspace",
      repositories: [{
        relativePath: "api",
        repositoryId: "repository-old",
        cloudDeletedAt: "2026-09-01T00:00:00.000Z",
        cloudDeletionOperationId: "operation-api",
      }],
      cloudDeletedAt: "2026-09-01T00:00:00.000Z",
      cloudDeletionOperationId: "operation-project",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    writeProjectManifest(root, existing);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    promptAnswers.push("y", "");

    try {
      const result = await prepareProjectManifest(root, {
        root: {
          path: root,
          isGitRepository: false,
          hasHead: false,
          originUrl: null,
        },
        childRepositories: [{
          path: childPath,
          relativePath: "api",
          displayName: "api",
          originUrl: null,
        }],
        recommendation: "multi-repo",
        requiresConfirmation: true,
      }, {});

      expect(result.status).toBe("written");
      const replacement = readProjectManifest(root)!;
      expect(replacement.projectId).not.toBe(existing.projectId);
      expect(replacement.cloudDeletedAt).toBeUndefined();
      expect(replacement.repositories[0].repositoryId).not.toBe("repository-old");
      expect(replacement.repositories[0].cloudDeletedAt).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
