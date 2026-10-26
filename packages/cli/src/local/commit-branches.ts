import { collectBranches, collectDefaultBranch, collectGitRefsFingerprint, resolveCommitBranches, type GitCommit } from "@varveai/adit-cloud";
import { NON_MERGE_COMMIT_SQL, type LocalStore } from "@varveai/adit-core";
import { syncKey } from "./cloud-projection.js";

export interface CommitBranch {
  localRepositoryId: string;
  sha: string;
  branch: string;
}

export async function localCommitBranches(store: LocalStore, repository: { path: string; localRepositoryId: string }): Promise<CommitBranch[]> {
  const rows = store.db.prepare(`SELECT sha FROM adit_local_commits c WHERE repository=? AND ${NON_MERGE_COMMIT_SQL} ORDER BY sha`).all(repository.path) as { sha: string }[];
  if (!rows.length) return [];
  const fingerprint = await collectGitRefsFingerprint(repository.path);
  if (!fingerprint) throw new Error("Unable to read Git branch references");
  const key = `commit-branches:${syncKey(repository.path)}`;
  const signature = syncKey(fingerprint, rows);
  const cached = store.get<{ signature: string; branches: { sha: string; branch: string }[] } | null>(key, null);
  let branches = cached?.signature === signature ? cached.branches : undefined;
  if (!branches) {
    const refs = await collectBranches(repository.path);
    const commits: GitCommit[] = rows.map(({ sha }) => ({ sha, parentSha: null, authorName: "", authorEmail: "", date: "", message: "" }));
    await resolveCommitBranches(repository.path, commits, refs, await collectDefaultBranch(repository.path));
    if (await collectGitRefsFingerprint(repository.path) !== fingerprint) throw new Error("Git branches changed during collection");
    branches = commits.flatMap(commit => commit.branch ? [{ sha: commit.sha, branch: commit.branch }] : []);
    store.set(key, { signature, branches });
  }
  return branches.map(branch => ({ ...branch, localRepositoryId: repository.localRepositoryId }));
}
