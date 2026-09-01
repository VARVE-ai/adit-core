/**
 * Member-repository rename handling: the persisted repositoryId must survive
 * a directory rename (unique same-remote match), and must never be stolen
 * when the situation is ambiguous.
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeLocalRepositoryId,
  readProjectManifest,
  writeProjectManifest,
  type ProjectManifest,
} from "@varveai/adit-core";

const mocks = vi.hoisted(() => ({
  getHeadSha: vi.fn(async (_cwd: string) => null as string | null),
  getRemoteUrl: vi.fn(async (_cwd: string) => null as string | null),
  detectPlatforms: vi.fn(() => []),
  detectInstalledPlatforms: vi.fn(() => []),
  listAdapters: vi.fn(() => []),
  resolveAditHookBinary: vi.fn(() => "adit-hook"),
  getAdapter: vi.fn(),
}));

vi.mock("@varveai/adit-engine", () => ({
  getHeadSha: mocks.getHeadSha,
  getRemoteUrl: mocks.getRemoteUrl,
}));

vi.mock("@varveai/adit-hooks/adapters", () => ({
  detectPlatforms: mocks.detectPlatforms,
  detectInstalledPlatforms: mocks.detectInstalledPlatforms,
  listAdapters: mocks.listAdapters,
  resolveAditHookBinary: mocks.resolveAditHookBinary,
  getAdapter: mocks.getAdapter,
}));

import { initCommand } from "./init.js";

describe("initCommand member repository renames", () => {
  let root: string;
  let urlByPath: Record<string, string | null>;
  let originalExit: typeof process.exit;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adit-rename-"));
    urlByPath = {};
    vi.clearAllMocks();
    mocks.getHeadSha.mockResolvedValue(null);
    mocks.getRemoteUrl.mockImplementation(async (cwd: string) => urlByPath[cwd] ?? null);
    process.exitCode = undefined;
    originalExit = process.exit;
    originalLog = console.log;
    originalError = console.error;
    process.exit = vi.fn((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never;
    console.log = vi.fn() as never;
    console.error = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  });

  function addRepo(name: string, remote: string | null): void {
    mkdirSync(join(root, name, ".git"), { recursive: true });
    if (remote) urlByPath[join(root, name)] = remote;
  }

  function logOutput(): string {
    return vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(" "))
      .join("\n");
  }

  it("persists repository identities and remote hints in the manifest", async () => {
    addRepo("api", "https://example.com/api.git");
    addRepo("web", "https://example.com/web.git");

    await initCommand({ cwd: root, multiRepo: true });

    const manifest = readProjectManifest(root)!;
    const api = manifest.repositories.find((repo) => repo.relativePath === "api")!;
    expect(api.repositoryId).toBe(computeLocalRepositoryId(manifest.projectId, "api"));
    expect(api.repositoryUrl).toBe("https://example.com/api.git");
  });

  it("carries the identity across a directory rename (unique same-remote match)", async () => {
    addRepo("api", "https://example.com/api.git");
    addRepo("web", "https://example.com/web.git");
    await initCommand({ cwd: root, multiRepo: true });
    const before = readProjectManifest(root)!;
    const apiId = before.repositories.find((repo) => repo.relativePath === "api")!.repositoryId;
    const webId = before.repositories.find((repo) => repo.relativePath === "web")!.repositoryId;

    renameSync(join(root, "api"), join(root, "renamed-api"));
    urlByPath[join(root, "renamed-api")] = "https://example.com/api.git";

    await initCommand({ cwd: root, multiRepo: true });

    const after = readProjectManifest(root)!;
    expect(after.repositories.map((repo) => repo.relativePath)).toEqual(["renamed-api", "web"]);
    expect(after.repositories.find((repo) => repo.relativePath === "renamed-api")!.repositoryId).toBe(apiId);
    expect(after.repositories.find((repo) => repo.relativePath === "web")!.repositoryId).toBe(webId);
    expect(after.projectId).toBe(before.projectId);
    expect(logOutput()).toContain("identity preserved");
  });

  it("never guesses when two new directories share the disappeared repo's remote", async () => {
    addRepo("api", "https://example.com/api.git");
    await initCommand({ cwd: root, multiRepo: true });
    const apiId = readProjectManifest(root)!.repositories[0].repositoryId;

    renameSync(join(root, "api"), join(root, "renamed-api"));
    urlByPath[join(root, "renamed-api")] = "https://example.com/api.git";
    addRepo("second-clone", "https://example.com/api.git");

    await initCommand({ cwd: root, multiRepo: true });

    const after = readProjectManifest(root)!;
    for (const repo of after.repositories) {
      expect(repo.repositoryId).not.toBe(apiId);
    }
  });

  it("keeps identities attached to paths when two directories swap names", async () => {
    addRepo("api", "https://example.com/api.git");
    addRepo("web", "https://example.com/web.git");
    await initCommand({ cwd: root, multiRepo: true });
    const before = readProjectManifest(root)!;
    const apiId = before.repositories.find((repo) => repo.relativePath === "api")!.repositoryId;

    renameSync(join(root, "api"), join(root, "swap-tmp"));
    renameSync(join(root, "web"), join(root, "api"));
    renameSync(join(root, "swap-tmp"), join(root, "web"));
    urlByPath[join(root, "api")] = "https://example.com/web.git";
    urlByPath[join(root, "web")] = "https://example.com/api.git";

    await initCommand({ cwd: root, multiRepo: true });

    const after = readProjectManifest(root)!;
    // Pinned behavior: with the path set unchanged, identities stay with the
    // path (history follows the name); only the recorded remote hints refresh.
    expect(after.repositories.find((repo) => repo.relativePath === "api")!.repositoryId).toBe(apiId);
    expect(after.repositories.find((repo) => repo.relativePath === "api")!.repositoryUrl).toBe(
      "https://example.com/web.git",
    );
  });

  it("drops unmatched removed entries and mints fresh identities for new repos", async () => {
    addRepo("api", "https://example.com/api.git");
    addRepo("web", "https://example.com/web.git");
    await initCommand({ cwd: root, multiRepo: true });
    const apiId = readProjectManifest(root)!.repositories.find(
      (repo) => repo.relativePath === "api",
    )!.repositoryId;

    rmSync(join(root, "api"), { recursive: true, force: true });
    addRepo("svc", "https://example.com/svc.git");

    await initCommand({ cwd: root, multiRepo: true });

    const after = readProjectManifest(root)!;
    expect(after.repositories.map((repo) => repo.relativePath)).toEqual(["svc", "web"]);
    expect(after.repositories.find((repo) => repo.relativePath === "svc")!.repositoryId).not.toBe(apiId);
  });

  it("backfills identities into manifests written before the field existed", async () => {
    addRepo("api", "https://example.com/api.git");
    const now = new Date().toISOString();
    const legacyManifest: ProjectManifest = {
      schemaVersion: 1,
      projectId: "11111111-2222-4333-8444-555555555555",
      projectType: "workspace",
      repositories: [{ relativePath: "api" }],
      createdAt: now,
      updatedAt: now,
    };
    writeProjectManifest(root, legacyManifest);

    await initCommand({ cwd: root });

    const after = readProjectManifest(root)!;
    expect(after.projectId).toBe(legacyManifest.projectId);
    expect(after.repositories[0].repositoryId).toBe(
      computeLocalRepositoryId(legacyManifest.projectId, "api"),
    );
    expect(after.repositories[0].repositoryUrl).toBe("https://example.com/api.git");
  });
});
