# Releasing ADIT

## Branches and checks

- Develop features on short-lived branches and open pull requests into `develop`.
- Prepare a release by opening a pull request from `develop` into `main`.
- `Checks / Build and test` runs on pull requests targeting either branch, and on
  pushes to `develop` and `main`. Other branch pushes do not trigger it; manual
  runs are available. It builds, checks types, runs release-script tests, and runs
  the application tests. It has no publishing credentials.
- Configure branch rules to require pull requests and the `Build and test` check
  before merging. Workflow files alone do not enforce branch protection.
- Historical lint/format cleanup remains separate. This change does not enable
  the old, nonfunctional checks on main or import the tooling changes from develop.
  When incremental formatting is enabled later, give it the pull request base;
  a clean checkout alone has no uncommitted changes to check.

## One-time configuration

1. Merge these workflow changes into `main` before running the release workflow.
2. Keep the existing `NPM_TOKEN` secret during migration, or configure trusted
   publishing for **each** of `@varveai/adit-core`, `@varveai/adit-engine`,
   `@varveai/adit-cloud`, and `@varveai/adit-cli`:
   - GitHub owner: `VARVE-ai`; repository: `adit-core`.
   - Workflow filename: `deploy-production.yml`.
   - Allow both direct `npm publish` and `npm dist-tag` operations.
   - The workflow pins npm 11.21.1, which supports both operations via OIDC.
   - Do not remove the token until trusted publishing is confirmed working.
   - Public packages built from a public repository receive automatic provenance
     when using trusted publishing; a private repository does not get that proof.
3. Configure branch protection separately. This code change does not change
   repository visibility, permissions, npm settings, or existing releases.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm distribution tags](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/).

## Release procedure

1. Review the changes on `main`. Choose an explicit stable version (such as
   `1.1.5`) and write user-facing changes, compatibility notes, and upgrade steps.
   All four public packages share this version; prereleases and automatic version
   increments are not supported by this production workflow.
2. Run **Deploy production** on **main** with `dry_run` enabled first. The run is
   pinned to its starting commit, even if main advances later. It builds and tests,
   prepares package documentation, writes versions into the packaging workspace,
   and packs the four packages once. Source manifest changes are restored afterward.
3. Download `release-packages` to inspect the actual archives and manifest. Package
   checks require licenses, the CLI README, installer, compiled entry points, web
   UI, and share renderer. Isolated Linux, Windows, and macOS jobs install these
   archives and verify versions, internal dependencies, the native database,
   local HTTP server, web assets, and share-renderer imports.
4. Run with the **same version and reviewed main commit** and `dry_run` disabled.
   If main moved after rehearsal, rehearse the new commit before releasing it.
   The workflow builds/checks again, creates the source tag and a draft GitHub
   release, and saves exact package archives plus their integrity hashes there.
   The saved archives go through all three installation jobs before npm upload.
5. Upload in dependency order: core → engine → cloud → CLI. Initially use the
   `candidate` distribution tag, leaving `latest` unchanged. These are public
   packages already, not private staging packages or beta version numbers.
   After each upload, allow up to five minutes for npm processing before failing;
   a timeout leaves the release resumable without overwriting uploaded packages.
6. Install the exact uploaded CLI version from npm in a clean Linux environment.
   Only after verification, promote the four packages to `latest` (CLI last) and
   publish the GitHub release with the supplied notes and source/run links.

Only the release workflow publishes. Pushing tags or publishing a GitHub release
manually does not launch a second publisher. Releases are serialized, and active
publishing runs are never automatically canceled by a newer release run.

## Failures and retries

- A rehearsal writes no remote tags, releases, packages, or distribution tags.
- Any lookup failure other than a confirmed 404 stops the process. Registry errors
  are not treated as evidence that a version is available.
- Re-run the **original failed Actions run** to retain its source commit/version.
  Do not start a new release from a changed main with the same version.
- A draft release with a manifest supplies the original archives on retry. Existing
  npm packages are skipped only when their identity and integrity match exactly.
  A collision stops the whole batch before further uploads.
- Interrupted draft asset upload: matching existing files can be reused; differing
  files are rejected rather than overwritten. The manifest is uploaded last.
- Updating four `latest` tags and publishing a GitHub release is not atomic. A late
  failure can leave some tags updated or the release still a draft; re-running
  completes the remaining operations after verifying the same package content.
- Do not move/reuse a source tag or overwrite published package contents. A code
  defect needs a new version. Existing v1.1.4 remains unchanged.
- If emergency rollback is needed, explicitly decide which default package versions
  to restore; this workflow never automatically rolls `latest` back.

The installation smoke check intentionally runs the installed server without
registering login startup or opening a browser. The existing installation tests
cover setup behavior; physical desktop/browser and login-after-reboot checks are
not claimed by the package smoke test.
