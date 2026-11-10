import { stat } from "node:fs/promises";
import { ATTRIBUTION_RESULT_TABLES, type LocalStore } from "@varveai/adit-core";

type Commit = { repository: string; sha: string };
export type CommitInput = { scope_revision: string; paths: string; evidence_revision: string };
export async function resumableCommits(
  store: LocalStore,
  workspace: string,
  version: number,
  commits: Commit[],
  analyzed: Set<string>,
  excluded: Set<string>,
  inputFor: (commit: Commit, paths: string[] | null) => CommitInput,
  sourcesAvailable: (run: string, commit: Commit) => boolean,
) {
  const result: (Commit & { run: string; input: CommitInput })[] = [];
  const manifests: unknown[][] = [];
  const allowed = new Set(commits.map((c) => c.repository + "\0" + c.sha));
  const seen = new Set<string>();
  const selectCommits = store.db.prepare(
    "SELECT repository,sha FROM adit_attribution_commits WHERE run_id=?",
  );
  const selectInput = store.db.prepare(
    "SELECT scope_revision,paths,evidence_revision FROM adit_attribution_inputs WHERE run_id=? AND repository=? AND sha=?",
  );
  const runs = store.db
    .prepare(
      `SELECT r.id,m.backup_manifest FROM adit_attribution_runs r
    JOIN adit_attribution_resume m ON m.run_id=r.id WHERE r.workspace_id=? AND r.status='failed'
    AND r.algorithm_version=? ORDER BY r.started_at DESC,r.rowid DESC`,
    )
    .all(workspace, version) as { id: string; backup_manifest: string }[];
  for (const run of runs) {
    const manifest = JSON.parse(run.backup_manifest) as unknown[][];
    let legacyValid: boolean | undefined;
    const validateLegacyBackups = async () => {
      if (legacyValid !== undefined) return legacyValid;
      legacyValid = true;
      for (const [path, size, modified] of manifest) {
        try {
          const current = await stat(String(path));
          if (current.size !== size || current.mtimeMs !== modified) {
            legacyValid = false;
            break;
          }
        } catch (error) {
          if (size !== "missing" || (error as NodeJS.ErrnoException).code !== "ENOENT") {
            legacyValid = false;
            break;
          }
        }
      }
      return legacyValid;
    };
    for (const commit of selectCommits.all(run.id) as Commit[]) {
      const key = commit.repository + "\0" + commit.sha;
      if (!allowed.has(key) || analyzed.has(key) || excluded.has(key) || seen.has(key)) continue;
      seen.add(key);
      const saved = selectInput.get(run.id, commit.repository, commit.sha) as
        CommitInput | undefined;
      // Legacy releases persisted complete commit transactions but no per-commit
      // input stamp. Keep that baseline when its sources/scope remain available.
      // Future retries use the stamp below instead of the workspace transcript.
      if (!sourcesAvailable(run.id, commit)) continue;
      if (!saved && !(await validateLegacyBackups())) continue;
      const paths = saved ? (JSON.parse(saved.paths) as string[] | null) : null;
      const input = inputFor(commit, paths);
      if (
        saved &&
        (input.scope_revision !== saved.scope_revision ||
          input.evidence_revision !== saved.evidence_revision)
      )
        continue;
      result.push({ run: run.id, repository: commit.repository, sha: commit.sha, input });
      analyzed.add(key);
    }
    manifests.push(...manifest);
  }
  return { commits: result, manifest: manifests };
}

/** A previous attempt is obsolete only once all of its completed SHAs have a
 * durable replacement. Keep untransferred results across interruption/recheck. */
export function pruneResumedRuns(store: LocalStore, workspace: string, run: string) {
  store.db
    .prepare(
      `DELETE FROM adit_attribution_runs AS r
    WHERE r.workspace_id=? AND r.status='failed' AND r.id<>? AND NOT EXISTS (
      SELECT 1 FROM adit_attribution_commits old WHERE old.run_id=r.id AND NOT EXISTS (
        SELECT 1 FROM adit_attribution_commits current WHERE current.run_id=?
          AND current.repository=old.repository AND current.sha=old.sha
      )
    )`,
    )
    .run(workspace, run, run);
}

/** Copy complete per-commit transactions; keep the old snapshot readable until publication. */
export function copyResumedCommits(
  store: LocalStore,
  run: string,
  commits: { run: string; repository: string; sha: string }[],
) {
  for (const suffix of ATTRIBUTION_RESULT_TABLES) {
    const table = `adit_attribution_${suffix}`;
    const columns = (
      store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((c) => c.name);
    const copy = store.db
      .prepare(`INSERT INTO ${table} (${columns.join(",")}) SELECT ${columns.map((c) => (c === "run_id" ? "?" : c)).join(",")}
      FROM ${table} WHERE run_id=? AND repository=? AND sha=?`);
    for (const commit of commits) copy.run(run, commit.run, commit.repository, commit.sha);
  }
}
