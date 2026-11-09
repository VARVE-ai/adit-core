/** Internal refs (checkpoints, stash, tool indexes) are not business history. */
export const businessRefs = ["refs/heads", "refs/remotes", "refs/tags"];
export const businessHistory = ["--branches", "--remotes", "--tags"];
export const gitCollectionVersion = 2;

/** Read both the pre-versioning checkpoint and the current collection format. */
export function collectionCheckpointRefs(serialized: string): string {
  const snapshot: unknown = JSON.parse(serialized);
  if (Array.isArray(snapshot)) {
    if (typeof snapshot[0] === "string") return snapshot[0];
    if (snapshot[0] === gitCollectionVersion && typeof snapshot[1] === "string") {
      return snapshot[1];
    }
  }
  // Do not replace valid Cloud branch metadata with an empty list on bad input.
  throw new Error("Unsupported Git collection checkpoint; collect the repository again");
}

export async function collectionHead(git: (...args: string[]) => Promise<string>): Promise<string> {
  try {
    return (await git("rev-parse", "--verify", "--quiet", "HEAD")).trim();
  } catch (error) {
    // An unborn HEAD is normal. Permission, timeout and executable failures are not.
    if ((error as { code?: number }).code === 1) return "";
    throw error;
  }
}
