import { stat } from "node:fs/promises";
import { ATTRIBUTION_RESULT_TABLES, type LocalStore } from "@varveai/adit-core";

type Commit = { repository: string; sha: string };
export async function resumableCommits(
  store: LocalStore,
  workspace: string,
  revision: string,
  commits: Commit[],
  analyzed: Set<string>,
  excluded: Set<string>,
) {
  const result: { run: string; repository: string; sha: string }[] = [];
  const manifests: unknown[][] = [];
  const allowed = new Set(commits.map((c) => c.repository + "\0" + c.sha));
  const runs = store.db
    .prepare(
      `SELECT r.id,m.backup_manifest FROM adit_attribution_runs r
    JOIN adit_attribution_resume m ON m.run_id=r.id WHERE r.workspace_id=? AND r.status='failed'
    AND m.input_revision=? ORDER BY r.started_at DESC`,
    )
    .all(workspace, revision) as { id: string; backup_manifest: string }[];
  for (const run of runs) {
    const manifest = JSON.parse(run.backup_manifest) as unknown[][];
    let valid = true;
    for (const [path, size, modified] of manifest) {
      try {
        const current = await stat(String(path));
        if (current.size !== size || current.mtimeMs !== modified) {
          valid = false;
          break;
        }
      } catch (error) {
        if (size !== "missing" || (error as NodeJS.ErrnoException).code !== "ENOENT") {
          valid = false;
          break;
        }
      }
    }
    if (!valid) continue;
    for (const commit of store.db
      .prepare("SELECT repository,sha FROM adit_attribution_commits WHERE run_id=?")
      .all(run.id) as Commit[]) {
      const key = commit.repository + "\0" + commit.sha;
      if (!allowed.has(key) || analyzed.has(key) || excluded.has(key)) continue;
      result.push({ run: run.id, repository: commit.repository, sha: commit.sha });
      analyzed.add(key);
    }
    manifests.push(...manifest);
  }
  return { commits: result, manifest: manifests };
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
