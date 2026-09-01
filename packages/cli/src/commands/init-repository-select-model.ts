export interface RepositorySyncChoice {
  relativePath: string;
  preChecked: boolean;
  cloudDeleted: boolean;
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
