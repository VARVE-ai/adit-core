# Workspace Project Repositories

## Problem

ADIT originally treated a local project and a Git repository as the same thing.
That model works for a normal repo checkout, but it breaks down when the user
works from a parent directory that contains several Git projects.

In that workflow, the parent directory is the place where the AI coding tool is
opened and where ADIT hooks should live. The child Git repositories are data
sources for remotes, branches, commits, and documents. They are not separate
ADIT entrypoints from the user's point of view.

Without a workspace model, several things go wrong:

- `adit init` refuses to run because the parent directory is not a Git repo.
- `loadConfig()` falls back to the nearest Git root, which points at one child
  repo instead of the parent workspace.
- cloud sync can send only one `remoteUrl` and one `canonicalRepoKey`.
- project-link cache is keyed only by project and server, so multiple repos can
  overwrite each other's branch, commit, and document sync state.
- cloud cannot populate `project_repositories` for workspace projects.

## Local Model

Core now separates the local ADIT project from the Git repositories under it.

The project shape is represented by:

- `projectType`: either `"repo"` or `"workspace"`.
- `projectId`: the top-level local project ID.
- `repositories`: the Git repositories that belong to that project.

For a normal repo project:

- `projectType` is `"repo"`.
- `projectId` keeps the previous ID behavior.
- `repositories` contains one entry with `relativePath: "."`.
- `localRepositoryId` is equal to `projectId`.

For a workspace project:

- `projectType` is `"workspace"`.
- `projectId` comes from `.adit/workspace.json`.
- only immediate child directories are scanned for Git repositories.
- each child repo gets a stable `localRepositoryId` derived from
  `workspaceId + relativePath`.
- the workspace parent can be a non-Git directory.

The discovery and manifest helpers live in:

```text
packages/core/src/config/project.ts
```

`loadConfig()` resolves the current local project without inheriting a parent
workspace. If the current directory is inside a Git repository, that Git root is
the project root. Otherwise, the current directory itself is the project root.
The project is a workspace only when that resolved root contains
`.adit/workspace.json`. This means commands launched from the workspace root use
the workspace, while commands launched from any uninitialized child directory
report that `adit init` is required instead of falling back to the parent
workspace.

## Initialization Flow

`adit init` now supports two paths.

Normal repo path:

1. Current directory is inside a Git repo.
2. ADIT uses the Git root as before.
3. `.adit/`, SQLite, `.gitignore`, hooks, generated document templates, and AI
   skill files are written relative to that root.

Workspace path:

1. Current directory is not a Git repo.
2. ADIT scans only the current directory's immediate child directories.
3. If at least one child contains `.git`, ADIT prints a workspace candidate
   warning and lists the repositories.
4. In an interactive terminal, the user must type `yes` to continue unless
   `--workspace` was supplied.
5. In a non-interactive environment, ADIT refuses to continue unless
   `--workspace` was supplied.
6. ADIT writes `.adit/workspace.json` and initializes the parent directory as
   the project root.

Hooks and AI platform config are installed only at the workspace parent. ADIT
does not install hooks into every child repo, because the user is expected to
operate from the parent directory.

The CLI flag is:

```bash
adit init --workspace
```

Use this flag for scripts, CI, or any non-interactive setup that intentionally
initializes a multi-project parent directory.

## Cloud Sync

Cloud sync now sends repository identity in addition to the existing project
identity.

Every `/api/sync/push` request includes:

- `projectType`
- `repositories`

Normal repo requests continue to include the old fields:

- `remoteUrl`
- `canonicalRepoKey`

This keeps old repo semantics intact while giving updated cloud servers enough
information to upsert `project_repositories`.

For a workspace project, the parent directory's remote is not used as the
project remote. The workspace is a container, so Git address data comes only
from the discovered child repositories.

For compatibility, cloud routes should distinguish between an explicitly sent
`projectType` and a missing one. Missing `projectType` is treated as `"repo"`
when creating a new project for an old client, but it should not force an
existing workspace project back to `"repo"`.

The cloud-facing context is assembled in:

```text
packages/cloud/src/project-context.ts
```

That module enriches core's synchronous repository list with Git remote data
from each child repo. It intentionally lives in the cloud package because Git
remote collection is async and cloud-specific.

## Project Link

`adit cloud link` now works from a workspace root.

For a repo project, project-link still processes a single repository at
`relativePath: "."`.

For a workspace project, project-link loops over each discovered repository and
runs the existing Git metadata upload flow per repository:

- negotiate project and repository identity
- upload branches and default branch
- upload commits
- discover and upload documents
- update local cache

Commit upload has one workspace-specific guard: if multiple child directories
contain the same commits, ADIT should not upload those commit objects once per
directory. During a single `adit cloud link` run, core keeps an in-memory set of
commit SHAs that have already been uploaded by earlier repositories in the
workspace loop.

For later repositories, commits whose SHA was already seen in the current
workspace link run are skipped, regardless of whether the repositories share the
same `canonicalRepoKey` or `repositoryUrl`. This also covers forked repositories
that have different remotes but share history. If a later repository has a mix
of old and new SHAs, only the new SHAs are uploaded. Branch metadata is still
uploaded per repository, because each `ProjectRepository` owns its own
`ProjectLink` and branch/default-branch state.

This dedupe is intentionally scoped to one workspace link run. It does not query
cloud for all previously uploaded SHAs, and it does not change normal repo
project commit upload behavior. Persistent link cache state still lives in each
repository's `project_link_cache` row, so branch freshness, document hashes,
qualification, refs fingerprints, and other repository-local markers remain
isolated per child repository.

Each project-link API call includes:

- `projectType`
- `localProjectId`
- `localRepositoryId`
- `relativePath`
- `remoteUrl` / `repositoryUrl`
- `canonicalRepoKey`

For workspace projects, `negotiate` and `init` also send the full
`repositories` list, not only the repository currently being linked. This lets
cloud bind a pending workspace team invitation by comparing the whole workspace
repository set, without depending on which child repository is linked first.

Documents still belong to the top-level project. When documents come from a
child repository, the uploaded cloud `sourcePath` is prefixed with the child
repository's `relativePath`.

Document discovery keeps the existing project-link behavior: normal project
docs such as `README.md` and `docs/**/*.md` are discovered, and ADIT-generated
project docs in `.adit/docs/**/*.md` are also intentionally discovered. Other
hidden directories remain excluded.

Example:

```text
local child repo file: README.md
repository relativePath: adit-core
cloud document sourcePath: adit-core/README.md
```

This keeps documents from different child repositories from overwriting each
other when they have the same repo-local path, such as `README.md`.

The workspace summary returned by `linkCommand()` aggregates branch, commit,
document, timing, and qualification data across child repositories.

When `adit cloud link --force` runs for a workspace, each repository reset
clears only that repository's cloud link data and CLI-uploaded documents under
its prefixed `sourcePath`. A reset for `adit-cloud` does not delete
`adit-core/...` documents.

## Local Cache

The `project_link_cache` table now includes `repository_id`.

The cache key changed from:

```text
project_id + server_url
```

to:

```text
project_id + repository_id + server_url
```

This prevents a workspace repo from overwriting another repo's:

- last uploaded commit SHA
- branch sync timestamp
- document sync timestamp
- document hashes
- qualification flag
- refs fingerprint metadata

The per-repository cache isolation remains true even when two child directories
share the same `canonicalRepoKey` or `repositoryUrl`. The duplicate-commit
filter is a transient upload optimization only; it does not merge cache rows or
make two child directories share branch/doc/qualification state.

Migration `12` rebuilds the existing cache table and backfills old rows with
`repository_id = project_id`. That preserves the normal repo behavior and keeps
old cache rows usable.

## Hook Behavior

Workspace roots may not be Git repositories. Hook context setup therefore treats
Git branch and remote metadata as optional.

When a hook creates a new session:

- branch lookup failure becomes `"unknown"`.
- remote lookup failure is omitted from metadata.
- the session still records against the workspace `projectId`.

This keeps hooks fail-open and lets workspace-root AI sessions record timeline
events even when the root itself has no `.git` directory.

Project-link auto-sync also checks cache freshness per repository. If any child
repo has no cache, stale cache, or changed refs, the detached `adit cloud link`
process is spawned from the workspace root.

### Stop-Hook Git Metadata

For workspace projects, the stop hook writes Git metadata only for child
repositories that were touched by the current AI turn.

The current-turn file set comes from hook transcript mutation evidence, such as
Codex `apply_patch` calls and conservative Bash write-target extraction. Bash
commands are considered only when the transcript exposes concrete paths that the
command wrote, deleted, moved, copied, or redirected into. ADIT does not use
`git status`, dirty working-tree scans, or pre-existing uncommitted changes to
decide which workspace repositories belong to the current turn.

For each current-turn path, ADIT resolves the path against the command/session
working directory and matches it to `config.repositories[].path`. Matching
repositories are deduplicated. The stop hook then records:

- one repository: that repository's current branch and `HEAD` SHA.
- multiple repositories: comma-joined branches and comma-joined `HEAD` SHAs.
- no current-turn file mutations: `git_branch = null` and `git_head_sha = null`.
- current-turn file mutations outside all child repositories: `git_branch = null`
  and `git_head_sha = null`.

This means a workspace that was already dirty before the AI turn does not get
Git metadata recorded merely because files were dirty. The metadata represents
only repositories with concrete file mutations observed during that stop-hook
cycle.

Normal repo projects keep the existing timeline Git metadata behavior. Cloud
schema does not change: `git_branch` and `git_head_sha` remain nullable strings,
and comma-joined workspace values are stored as-is.

## Cloud Contract

Updated cloud servers should treat `projects` and `project_repositories` as
separate layers.

Expected behavior:

- repo project: `projects.type = "repo"`.
- repo project: `projects.repository_url` keeps the existing remote URL.
- repo project: `project_repositories` has one row for `relativePath = "."`.
- workspace project: `projects.type = "workspace"`.
- workspace project: `projects.repository_url = null`.
- workspace project: `project_repositories` has one row per uploaded child repo.

The repository payload shape is:

```ts
{
  localRepositoryId: string;
  relativePath: string;
  displayName?: string;
  repositoryUrl?: string;
  canonicalRepoKey?: string;
}
```

Old clients and old requests remain compatible:

- missing `projectType` should be interpreted as `"repo"`.
- missing `repositories` with a present `remoteUrl` should synthesize one repo
  at `relativePath = "."`.

## Important Constraints

- Workspace repository discovery is intentionally shallow. It scans one level
  below the workspace root and does not recurse.
- A workspace with one child repo is valid.
- The workspace parent is the ADIT project root and the AI tool entrypoint.
- Child repos are Git metadata sources, not independent ADIT usage roots.
- Workspace `projects.repository_url` should remain empty on the cloud side.
- `ProjectRepository` should not gain `defaultBranch`, `primary`, `status`, or
  `source`; those belong to link/branch metadata, not the repository identity.

## Regression Checks

Run the focused test set for this feature:

```bash
pnpm test -- \
  packages/core/src/config/project.test.ts \
  packages/cli/src/commands/init.test.ts \
  packages/cloud/src/project-link/cache.test.ts \
  packages/cloud/src/project-link/link-command.test.ts \
  packages/cloud/src/project-link/qualify.test.ts \
  packages/cloud/src/sync/engine.test.ts \
  packages/cloud/src/project-link/auto-link.test.ts
```

Run package typechecks after changing public types or cross-package exports:

```bash
pnpm --filter @varveai/adit-core typecheck
pnpm --filter @varveai/adit-cloud typecheck
pnpm --filter @varveai/adit-cli typecheck
pnpm --filter @varveai/adit-hooks typecheck
pnpm --filter @varveai/adit-engine typecheck
```

When typechecking packages that depend on changed public types, rebuild the
provider package declarations first if the dependent package still reads old
`dist/*.d.ts` files.

## Manual Verification

Create a temporary parent directory with child repos:

```bash
mkdir /tmp/adit-ws
cd /tmp/adit-ws
mkdir api web
git -C api init
git -C web init
```

Initialize as a workspace:

```bash
adit init --workspace
```

Expected local state:

- `/tmp/adit-ws/.adit/workspace.json` exists.
- `/tmp/adit-ws/.adit/adit.sqlite` exists.
- child repos do not get their own `.adit/` directories from this init.
- `adit config --json` reports `projectType: "workspace"` and repository
  entries for `api` and `web`.

Then add remotes to the child repos and run:

```bash
adit cloud sync
adit cloud link
```

Expected cloud behavior:

- sync payload contains `projectType: "workspace"`.
- sync payload contains one repository entry per child repo.
- project-link calls include `localRepositoryId` and `relativePath`.
- cache rows are separate for each child repo.

Stop-hook metadata check:

- after a turn that edits only `api`, `events.git_head_sha` contains only the
  current `api` `HEAD` SHA.
- after a turn that edits both `api` and `web`, `events.git_head_sha` contains
  both current child-repo `HEAD` SHAs as a comma-joined string.
- after a turn with no file mutations, or with mutations only outside child
  repositories, workspace `assistant_response` events store `null` for
  `git_branch` and `git_head_sha`.
