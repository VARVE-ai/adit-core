export interface RepositorySyncChoice {
  relativePath: string;
  preChecked: boolean;
  cloudDeleted: boolean;
}

/** Human label for a choice: the root entry reads "./ (this directory)". */
export function repositoryChoiceLabel(choice: Pick<RepositorySyncChoice, "relativePath">): string {
  return choice.relativePath === "." ? "./ (this directory)" : choice.relativePath;
}

export function describeRepositoryChoice(
  choice: RepositorySyncChoice,
  checked: boolean,
): string {
  if (choice.cloudDeleted) {
    return checked ? "recreate as new" : "deleted in Cloud";
  }
  return checked ? "sync" : "not synced";
}
