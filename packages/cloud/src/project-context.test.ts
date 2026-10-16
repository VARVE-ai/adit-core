import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, writeProjectManifest } from "@varveai/adit-core";
import { resolveCloudProjectContext } from "./project-context.js";

vi.mock("@varveai/adit-engine", () => ({ getRemoteUrl: vi.fn(async () => "https://github.com/test/repo.git") }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("project registration snapshots", () => {
  it.each([
    [{ relativePath: "." }],
    [{ relativePath: "test2" }, { relativePath: "test3" }],
    [{ relativePath: "." }, { relativePath: "test2" }],
  ])("keeps workspace Git identity empty for repository selection %j", async (...repositories) => {
    const root = mkdtempSync(join(tmpdir(), "adit-workspace-address-")); roots.push(root);
    writeProjectManifest(root, { schemaVersion: 3, projectId: "workspace", repositories,
      createdAt: "2026-09-09T01:00:00.000Z", updatedAt: "2026-09-09T01:00:00.000Z" });
    const context = await resolveCloudProjectContext(loadConfig(root));
    expect(context.remoteUrl).toBeNull();
    expect(context.canonicalRepoKey).toBeNull();
    expect(context.repositories).toHaveLength(repositories.length);
    for (const repository of context.repositories) {
      expect(repository.repositoryUrl).toBe("https://github.com/test/repo.git");
      expect(repository.canonicalRepoKey).toBe("github:test/repo");
    }
    expect(context.registration?.repositories).toHaveLength(repositories.length);
  });

  it("refreshes a daemon's stale repository selection and sends excluded identities with no uploads", async () => {
    const root = mkdtempSync(join(tmpdir(), "adit-project-context-")); roots.push(root);
    const first = { schemaVersion: 3 as const, projectId: "parent", repositories: [{ relativePath: "test4", repositoryId: "parent-test4" }],
      createdAt: "2026-09-09T01:00:00.000Z", updatedAt: "2026-09-09T01:00:00.000Z" };
    writeProjectManifest(root, first);
    const config = loadConfig(root);
    writeProjectManifest(root, { ...first, updatedAt: "2026-09-09T02:00:00.000Z", repositories: [{ ...first.repositories[0], syncEnabled: false }] });
    const context = await resolveCloudProjectContext(config);
    expect(context.repositories).toEqual([]);
    expect(context.registration?.repositories).toMatchObject([{ localRepositoryId: "parent-test4", relativePath: "test4", included: false }]);
    expect(context.registration?.updatedAt).toBe("2026-09-09T02:00:00.000Z");
  });

  it("does not turn an old merged manifest into an explicit restoration request", async () => {
    const root = mkdtempSync(join(tmpdir(), "adit-project-context-")); roots.push(root);
    writeProjectManifest(root, { schemaVersion: 2, projectId: "child", mergedIntoProjectId: "parent", repositories: [{ relativePath: "." }],
      createdAt: "2026-09-09T01:00:00.000Z", updatedAt: "2026-09-09T01:00:00.000Z" });
    expect((await resolveCloudProjectContext(loadConfig(root))).registration).toBeUndefined();
  });
});
