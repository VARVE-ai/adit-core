/** Repository upload selection used exclusively by `adit init`. */

import { createInterface } from "node:readline/promises";
import {
  generateRepositoryId,
  type ProjectManifestRepository,
} from "@varveai/adit-core";
import { canUseInkSelect } from "./init-select-ink.js";
import { runInkRepositorySelect } from "./init-repository-select-ink.js";
import {
  describeRepositoryChoice,
  type RepositorySyncChoice,
} from "./init-repository-select-model.js";

export { describeRepositoryChoice };
export type { RepositorySyncChoice };

export function buildRepositorySyncChoices(
  repositories: ProjectManifestRepository[],
): RepositorySyncChoice[] {
  return repositories.map((repository) => ({
    relativePath: repository.relativePath,
    preChecked: repository.syncEnabled !== false && !repository.cloudDeletedAt,
    cloudDeleted: Boolean(repository.cloudDeletedAt),
  }));
}

export function parseRepositorySelection(
  answer: string,
  choices: RepositorySyncChoice[],
): Set<string> | null {
  const selected = new Set(
    choices.filter((choice) => choice.preChecked).map((choice) => choice.relativePath),
  );
  const normalized = answer.trim().toLowerCase();

  if (!normalized) return selected;
  if (normalized === "a") return new Set(choices.map((choice) => choice.relativePath));
  if (normalized === "n") return new Set();

  const tokens = [...new Set(normalized.split(/[\s,]+/u).filter(Boolean))];
  for (const token of tokens) {
    if (!/^\d+$/u.test(token)) return null;
    const choice = choices[Number.parseInt(token, 10) - 1];
    if (!choice) return null;
    if (selected.has(choice.relativePath)) selected.delete(choice.relativePath);
    else selected.add(choice.relativePath);
  }
  return selected;
}

export async function promptRepositorySelection(
  repositories: ProjectManifestRepository[],
): Promise<ProjectManifestRepository[]> {
  const choices = buildRepositorySyncChoices(repositories);
  console.log("  Select repositories to sync to ADIT Cloud:");

  if (canUseInkSelect()) {
    try {
      const selection = await runInkRepositorySelect(choices);
      return applyRepositorySelection(repositories, selection);
    } catch {
      // Terminal rejected raw mode; use the plain prompt below.
    }
  }

  for (const [index, choice] of choices.entries()) {
    const mark = choice.preChecked ? "x" : " ";
    const state = choice.cloudDeleted
      ? "deleted in Cloud; select to recreate"
      : describeRepositoryChoice(choice, choice.preChecked);
    console.log(`    ${index + 1}. [${mark}] ${choice.relativePath} (${state})`);
  }
  console.log("  Enter numbers to toggle, 'a' for all, 'n' for none, or Enter to keep.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("  Select: ");
    const selection = parseRepositorySelection(answer, choices);
    if (selection === null) {
      console.log("  [=] Unrecognized selection; keeping the current repository settings.");
      return repositories;
    }
    return applyRepositorySelection(repositories, selection);
  } finally {
    rl.close();
  }
}

export function applyRepositorySelection(
  repositories: ProjectManifestRepository[],
  selection: ReadonlySet<string>,
  createRepositoryId: () => string = generateRepositoryId,
): ProjectManifestRepository[] {
  return repositories.map((repository) => {
    const selected = selection.has(repository.relativePath);
    if (!repository.cloudDeletedAt || !selected) {
      return repository.cloudDeletedAt
        ? repository
        : { ...repository, syncEnabled: selected };
    }

    const activeRepository = { ...repository };
    delete activeRepository.cloudDeletedAt;
    delete activeRepository.cloudDeletionOperationId;
    return {
      ...activeRepository,
      repositoryId: createRepositoryId(),
      syncEnabled: true,
    };
  });
}
