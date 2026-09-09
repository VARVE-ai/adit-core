import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeLocalRepositoryId,
  readProjectManifest,
  writeProjectManifest,
  resolveManifestRepositories,
  withProjectInitLock,
  type ProjectManifest,
} from "@varveai/adit-core";
import type { ProjectLayoutAnalysis } from "./project-layout.js";

const promptAnswers = vi.hoisted(() => [] as string[]);
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: vi.fn(async () => {
      const answer = promptAnswers.shift() ?? "";
      if (answer === "interrupt") throw new Error("Interrupted selection");
      return answer;
    }),
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

describe("independent project initialization recovery", () => {
  const analysisFor = (root: string): ProjectLayoutAnalysis => ({
    root: { path: root, isGitRepository: true, hasHead: true, originUrl: "https://example.com/root.git" },
    childRepositories: [{ path: join(root, "test4"), relativePath: "test4", displayName: "test4", originUrl: "https://example.com/test4.git", existingProject: null }],
  });

  it("repairs an old absorbed root collision while keeping the child's identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "adit-collision-repair-"));
    const now = new Date().toISOString();
    try {
      writeProjectManifest(root, { schemaVersion: 2, projectId: "absorbed-child", createdAt: now, updatedAt: now,
        repositories: [{ relativePath: "." }, { relativePath: "test4", repositoryId: "absorbed-child" }],
      });
      await prepareProjectManifest(root, analysisFor(root), { repos: [".", "test4"] });
      const repaired = readProjectManifest(root)!;
      const ids = resolveManifestRepositories(root, repaired).map((r) => r.localRepositoryId);
      expect(new Set(ids).size).toBe(2);
      expect(ids[1]).toBe("absorbed-child");
      await prepareProjectManifest(root, analysisFor(root), { repos: [".", "test4"] });
      expect(resolveManifestRepositories(root, readProjectManifest(root)!).map((r) => r.localRepositoryId)).toEqual(ids);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("an interrupted selection leaves both manifests intact and retry preserves identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "adit-interrupted-selection-"));
    const child = join(root, "test4");
    const now = new Date().toISOString();
    const plain = process.env.ADIT_PLAIN_PROMPTS;
    try {
      writeProjectManifest(child, { schemaVersion: 3, projectId: "child", repositories: [{ relativePath: "." }], createdAt: now, updatedAt: now });
      const before = readFileSync(join(child, ".adit", "project.json"), "utf8");
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      process.env.ADIT_PLAIN_PROMPTS = "1";
      promptAnswers.push("interrupt");
      await expect(prepareProjectManifest(root, analysisFor(root), {})).rejects.toThrow("Interrupted selection");
      expect(readProjectManifest(root)).toBeNull();
      expect(readFileSync(join(child, ".adit", "project.json"), "utf8")).toBe(before);
      await prepareProjectManifest(root, analysisFor(root), { repos: [".", "test4"] });
      const saved = readFileSync(join(root, ".adit", "project.json"), "utf8");
      await withProjectInitLock(root, async () => {
        await expect(prepareProjectManifest(root, analysisFor(root), {})).rejects.toThrow(/already|appears to be running/);
      });
      expect(readFileSync(join(root, ".adit", "project.json"), "utf8")).toBe(saved);
      expect(readFileSync(join(child, ".adit", "project.json"), "utf8")).toBe(before);
    } finally {
      if (plain === undefined) delete process.env.ADIT_PLAIN_PROMPTS; else process.env.ADIT_PLAIN_PROMPTS = plain;
      rmSync(root, { recursive: true, force: true });
    }
  });
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
        registeredBy: null,
      },
      childRepositories: [{
        path: "/workspace/api",
        relativePath: "api",
        displayName: "api",
        originUrl: "https://example.com/new.git",
        existingProject: null,
      }],
    };

    const replacement = createReplacementProjectManifest(
      existing,
      analysis,
      "project-new",
      "2026-09-01T01:00:00.000Z",
    );

    expect(replacement).toEqual({
      schemaVersion: 3,
      projectId: "project-new",
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
          existingProject: null,
        }],
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
