import { describe, expect, it } from "vitest";
import {
  applyRepositorySelection,
  buildRepositorySyncChoices,
  describeRepositoryChoice,
  parseRepositorySelection,
} from "./init-repository-select.js";

describe("init repository sync selection", () => {
  const choices = buildRepositorySyncChoices([
    { relativePath: "api", repositoryId: "repository-api" },
    { relativePath: "web", repositoryId: "repository-web", syncEnabled: false },
    {
      relativePath: "worker",
      repositoryId: "repository-worker",
      cloudDeletedAt: "2026-09-01T00:00:00.000Z",
      cloudDeletionOperationId: "operation-worker",
    },
  ]);

  it("preselects enabled repositories and leaves Cloud-deleted repositories unchecked", () => {
    expect(choices).toEqual([
      { relativePath: "api", preChecked: true, cloudDeleted: false },
      { relativePath: "web", preChecked: false, cloudDeleted: false },
      { relativePath: "worker", preChecked: false, cloudDeleted: true },
    ]);
  });

  it("describes checkbox states without requiring numbered-input knowledge", () => {
    expect(describeRepositoryChoice(choices[0], true)).toBe("included");
    expect(describeRepositoryChoice(choices[1], false)).toBe("excluded (history kept)");
    expect(describeRepositoryChoice(choices[2], false)).toBe("deleted in Cloud");
    expect(describeRepositoryChoice(choices[2], true)).toBe("recreate as new");
  });

  it("toggles numbered repositories against the saved selection", () => {
    expect(parseRepositorySelection("1,2", choices)).toEqual(new Set(["web"]));
  });

  it("supports all, none, and Enter, including explicit recreation of deleted repositories", () => {
    expect(parseRepositorySelection("", choices)).toEqual(new Set(["api"]));
    expect(parseRepositorySelection("a", choices)).toEqual(new Set(["api", "web", "worker"]));
    expect(parseRepositorySelection("n", choices)).toEqual(new Set());
  });

  it("recreates a selected Cloud-deleted repository with a fresh identity", () => {
    const repositories = [
      {
        relativePath: "worker",
        repositoryId: "repository-worker-old",
        cloudDeletedAt: "2026-09-01T00:00:00.000Z",
        cloudDeletionOperationId: "operation-worker",
      },
    ];

    const updated = applyRepositorySelection(
      repositories,
      new Set(["worker"]),
      () => "repository-worker-new",
    );

    expect(updated).toEqual([{
      relativePath: "worker",
      repositoryId: "repository-worker-new",
      syncEnabled: true,
    }]);
  });

  it("allows a deleted repository to be selected", () => {
    expect(parseRepositorySelection("3", choices)).toEqual(new Set(["api", "worker"]));
  });

  it("keeps a deleted repository and its old identity when it stays unchecked", () => {
    const repository = {
      relativePath: "worker",
      repositoryId: "repository-worker-old",
      cloudDeletedAt: "2026-09-01T00:00:00.000Z",
      cloudDeletionOperationId: "operation-worker",
    };
    expect(applyRepositorySelection([repository], new Set())).toEqual([repository]);
  });
});
