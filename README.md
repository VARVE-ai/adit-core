# ADIT Core

**AI Development Intent Tracker — a flight recorder for AI-assisted development**

ADIT is a local-first recorder for AI-assisted development. It records
prompts, assistant responses, tool activity, per-turn file diffs, environment
snapshots, and cloud sync state so a project can be inspected and understood
with context instead of guesswork — locally via CLI/TUI, and optionally in
the adit-cloud Coding panel.

## What ADIT Does

1. **Trace every AI-assisted change** — ADIT stores normalized timeline events
   for user prompts, assistant turns, tools, subagents, notifications, session
   lifecycle events, diffs, and related metadata.
2. **Capture per-turn file diffs** — ADIT extracts file mutations from platform
   transcripts on each turn and stores bounded diff text for inspection.
3. **Bridge local CLIs to adit-cloud** — `adit cloud claude|codex` connects a
   local Claude Code or Codex session to the adit-cloud Coding panel, and
   hook-driven auto-sync pushes timeline data incrementally.

## Features

- **Prompt and response capture** — Records AI coding interactions as local
  timeline events.
- **Per-turn diff capture** — Extracts file mutations from platform transcripts
  and stores diff stats plus bounded diff text per assistant turn.
- **Hook chaining** — Adds ADIT hooks while preserving existing tool hooks, and
  removes only ADIT-managed entries on reinstall or uninstall.
- **Multi-actor timeline** — Distinguishes user, assistant, tool, and system
  activity.
- **Environment snapshots** — Captures Git state, dependency versions, runtime
  context, Docker signals, shell details, CPU/memory, and package managers.
- **Environment drift detection** — Compares snapshots across sessions.
- **Cloud sync** — Supports device-code login, static token auth, cursor-based
  incremental push, per-project cursors, auto-sync, and a rolling-window
  circuit breaker.
- **Auto project link** — Syncs Git metadata and project documents to
  adit-cloud on session start with staleness-based caching.
- **Platform session tracking** — Correlates ADIT records with platform-native
  session IDs.
- **Interactive TUI** — React/Ink terminal UI with timeline, detail, search,
  diff, and environment screens.
- **Fail-open hooks** — Hook errors are swallowed so ADIT never blocks the AI
  agent.

## Architecture

ADIT is a TypeScript pnpm monorepo with six packages:

| Package | Description |
| --- | --- |
| `@varveai/adit-core` | Core types, SQLite database access, config, sync primitives, performance logs, and native install checks |
| `@varveai/adit-engine` | Git runner, working tree detection, timeline management, and environment capture/diff |
| `@varveai/adit-hooks` | Hook dispatcher, fail-open handlers, platform adapter registry, and hook install/validate/uninstall logic |
| `@varveai/adit-cli` | Commander.js CLI, cloud coding entry points, debug commands, docs commands, and React/Ink TUI |
| `@varveai/adit-cloud` | Cloud config, device/token auth, HTTP client, incremental sync, project-link sync, and intent commands |
| `@varveai/adit-plans` | Project document template generator and validator |

Package boundaries are intentionally small: `core` owns storage and shared
types, `engine` owns Git/timeline mechanics, `hooks` normalizes platform events,
`cli` owns user commands, `cloud` owns remote sync, and `plans` owns project
document templates and validation.

## Platform Support

ADIT uses a pluggable adapter pattern. Each adapter maps platform-specific hook
events to ADIT's normalized hook model.

| Platform | Status | Integration |
| --- | --- | --- |
| Claude Code | Supported | Installs hook entries in `.claude/settings.local.json` and slash command files under `.claude/commands/` |
| Claude Code VS Code | Supported | Uses the Claude Code hook mechanism with VS Code-aware platform detection |
| OpenCode | Supported | Generates `.opencode/plugins/adit.ts`, slash commands, and LLM-callable tools `adit_link` and `adit_intent` |
| Cursor | Supported | Installs hook entries in `.cursor/hooks.json` |
| Codex | Supported | Installs hook entries in `.codex/hooks.json`, enables Codex hooks, and writes ADIT hook trust config |
| Gemini CLI | Supported | Installs hook entries in `.gemini/settings.json` |
| GitHub Copilot | Stub | Detected by the registry, but hook install/parse support is not implemented yet |
| Other | Stub | Placeholder adapter for unknown platforms |

Registered adapters can be listed with:

```bash
adit hook list
```

## Installation

### npm

ADIT requires Node.js 22 or newer and installs without native build tools:
prebuilt SQLite binaries for all supported platforms ship inside the package.

```bash
npm install -g @varveai/adit-cli
adit --help
```

### Install Script

```bash
curl -fsSL https://raw.githubusercontent.com/VARVE-ai/adit-core/main/install.sh | bash
```

The install script detects macOS/Linux environments, installs missing
prerequisites when possible, builds all packages, and registers `adit` and
`adit-hook` on `PATH`.

### Manual Development Setup

```bash
git clone https://github.com/VARVE-ai/adit-core.git
cd adit-core
pnpm install
pnpm build
```

## Quick Start

```bash
# Initialize ADIT in a project and auto-detect available AI tool configs
adit init

# Install hooks for one platform
adit hook install codex

# Validate the local setup
adit doctor

# Show recent timeline events
adit timeline

# Launch the terminal UI
adit tui

# Authenticate with adit-cloud
adit cloud login --server <url>
```

## Projects & Initialization

`adit init` is the only command that decides what a project is. It writes
`.adit/project.json` — the project identity, the project type, and the explicit
repository member list. Every other command (status, doctor, link, sync, hooks)
only reads this manifest and never changes the project structure.

- **Single-repo project** — a normal Git repository. `adit init` sets it up
  without questions.
- **Multi-repo project** — a directory containing several Git repositories one
  level below (with or without a top-level `.git`). `adit init` lists the
  repositories and asks how to manage them. Non-interactive environments use
  `adit init --multi-repo` / `adit init --single-repo` explicitly.
- **Recording boundary** — for a multi-repo project, start your coding tools
  from the project root: work across all member repositories is recorded there.
  Sessions started inside a member repository are not recorded. To record a
  member repository on its own, run `adit init` inside it — it becomes an
  independent project and the parent project is not affected.
- **Adding / removing repositories** — nothing changes automatically. Re-run
  `adit init` in the project root and confirm the updated list; `adit status`
  and `adit doctor` point out unregistered or missing repositories.
- **Upgrading from an older adit** — projects initialized before the manifest
  existed show a one-time migration prompt. Run `adit init` once in each
  project: the project identity is carried over, so the cloud project, local
  history, team links and sync progress all stay attached. Recording is paused
  until the migration runs.

## CLI Commands

### Core

| Command | Description |
| --- | --- |
| `adit init` | Initialize ADIT in the current project (`--platform`, `--force`, `--single-repo`, `--multi-repo`) |
| `adit uninstall` | Remove ADIT from the current project (`--yes`, `--json`) |
| `adit status` | Show session, Git, sync, and hook status (`--json`) |
| `adit config` | Show resolved ADIT configuration (`--json`) |
| `adit doctor` | Validate SQLite, hooks, stale sessions, and disk usage (`--fix`, `--json`) |
| `adit tui` | Launch the interactive terminal UI |

### Timeline

| Command | Description |
| --- | --- |
| `adit timeline` | Show timeline entries; aliases: `list`, `ls` |
| `adit show <id>` | Show a full event detail view |
| `adit search <query>` | Search events by text with actor, type, date, branch, and checkpoint filters |
| `adit prompt <id>` | Show prompt text with `--max-chars` and `--offset` |

Common timeline options include `--limit`, `--actor`, `--type`,
`--query`, `--expand`, `--sort`, and `--json`.

### Snapshot

| Command | Description |
| --- | --- |
| `adit snapshot diff <id>` | Show the recorded diff for an event with line and file filters |
| `adit snapshot env show <id>` | Show the environment snapshot for an event |
| `adit snapshot env latest` | Show the most recent environment snapshot |
| `adit snapshot env diff <id1> <id2>` | Compare two environment snapshots |
| `adit snapshot env history` | List environment snapshot history |

### Hooks

| Command | Description |
| --- | --- |
| `adit hook install [platform]` | Install ADIT hooks for a platform |
| `adit hook uninstall [platform]` | Remove ADIT hooks; supports `--all` and `--clean` |
| `adit hook list` | List registered platform adapters |
| `adit hook validate [platform]` | Validate hook installation |

### Cloud Sync

| Command | Description |
| --- | --- |
| `adit cloud login` | Authenticate with device-code flow or `--token` |
| `adit cloud logout` | Clear stored cloud credentials |
| `adit cloud sync` | Push unsynced local records to adit-cloud |
| `adit cloud status` | Show cloud sync status and server reachability |
| `adit cloud auth reset` | Clear credentials and sync state |
### Cloud Coding

| Command | Description |
| --- | --- |
| `adit cloud claude [cliArgs...]` | Connect local Claude Code CLI to adit-cloud Coding |
| `adit cloud codex [cliArgs...]` | Connect local Codex CLI to adit-cloud Coding |

### Project Link

| Command | Description |
| --- | --- |
| `adit cloud link` | Upload Git metadata and project documents to adit-cloud |
| `adit cloud intent` | List or inspect connected project intents |
| `adit cloud intent complete <id>` | Complete one phase or an entire intent |

`adit cloud link` supports `--force`, `--skip-docs`, `--skip-commits`,
`--skip-qualify`, `--dry-run`, and `--json`. The same project-link and intent
flows are also exposed as `/adit link` and `/adit intent` in supported
platform integrations.

Link only connects an already initialized project: it reads the repository
list from `.adit/project.json`, validates every repository and its `origin`
remote locally **before** any authentication or network call, and never
modifies the project structure. Structural problems (missing repositories,
new unregistered repositories) are fixed by re-running `adit init`, not by
link. When a link would create a brand-new cloud project while the account
already has projects pointing at the same git remotes (typical after a fresh
clone or on a new machine), link prints a notice — nothing is merged.

### Export, Docs, Debug, Maintenance

| Command | Description |
| --- | --- |
| `adit export event <id>` | Export one event as JSON |
| `adit export session [id]` | Export a session as JSON, JSONL, or Markdown |
| `adit docs scaffold [type]` | Generate project document templates |
| `adit docs validate [path]` | Validate project documents against structural specs |
| `adit debug db clear-events` | Clear local events, sessions, diffs, and environment snapshots |
| `adit debug perf stats` | Show performance stats |
| `adit debug perf clear` | Clear performance logs |
| `adit upgrade` | Update ADIT or check for updates |

## Interactive TUI

Launch with:

```bash
adit tui
```

Screens include a live timeline, event detail view, diff viewer, search, and
environment snapshot view.

Common shortcuts: `j`/`k` navigate, `d` diff, `p` prompt, `e` environment, `/`
search, `f` filter, `s` cycle sort, `Esc`/`b` back, and `q` quit.

## Cloud Sync

Cloud sync is optional. After `adit cloud login`, ADIT automatically pushes
local events, sessions, diffs, sync cursors, Git metadata, and project documents
to adit-cloud — being logged in is the opt-in. Raw platform transcript files
remain local. Environment snapshots are also not included in Cloud sync
payloads. The login command prints exactly what is uploaded and how to disable
each channel; `adit status` surfaces sync health warnings.

- Auto-sync runs after stable hook events when credentials are available.
- `prompt-submit` is skipped so cloud does not receive a half-finished turn.
- Each project tracks its own cursor with legacy global-cursor fallback.
- Count-based auto-sync defaults to 10 unsynced events.
- Time-based auto-sync defaults to 2 hours since the last successful sync.
- Repeated failures trip a rolling-window circuit breaker and recover later.
- Network and auth errors are fail-open and retried on later triggers.

## Data Directory

By default, ADIT stores project-local data in `.adit/`:

| Path | Purpose |
| --- | --- |
| `.adit/adit.sqlite` | Events, sessions, diffs, environment snapshots, and sync state |

Machine-level data is stored under `~/.adit/`:

| Path | Purpose |
| --- | --- |
| `~/.adit/client-id` | Stable local client identifier |
| `~/.adit/cloud-credentials.json` | Cloud credentials, written with restricted permissions |

## Configuration

ADIT reads project settings from `settings.json` in the project root and then
applies environment variable overrides.

```json
{
  "captureEnv": true,
  "projectLink": {
    "docPatterns": [
      "*.md",
      "docs/**/*.md",
      "wiki/**/*.md"
    ],
    "excludePatterns": [
      "node_modules/**",
      ".git/**",
      "dist/**",
      "build/**"
    ]
  }
}
```

- `captureEnv` disables environment snapshots when set to `false`.
- `projectLink.docPatterns` replaces the default document include patterns.
- `projectLink.excludePatterns` replaces the default document exclude patterns.

Files in hidden directories are skipped during project-link document discovery.
Files larger than 500 KB are skipped with a warning.

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `ADIT_PROJECT_ROOT` | Override detected project root | Detected Git root or cwd |
| `ADIT_DATA_DIR` | Override local data directory | `<project>/.adit` |
| `ADIT_DB_PATH` | Override SQLite database path | `<dataDir>/adit.sqlite` |
| `ADIT_CLIENT_ID` | Override machine client ID | `~/.adit/client-id` |
| `ADIT_REMOTE_URL` | Remote URL used when computing project ID | unset |
| `ADIT_CAPTURE_ENV` | Set to `false` to disable environment snapshots | `true` |
| `ADIT_CLOUD_URL` | adit-cloud server URL | Credentials/server default |
| `ADIT_CLOUD_ENABLED` | Set to `false` to disable cloud features | `true` |
| `ADIT_CLOUD_AUTO_SYNC` | Set to `false` to disable auto-sync | `true` |
| `ADIT_CLOUD_BATCH_SIZE` | Max records per sync batch; capped at 500 | `500` |
| `ADIT_CLOUD_SYNC_THRESHOLD` | Unsynced event count that triggers auto-sync | `10` |
| `ADIT_CLOUD_SYNC_TIMEOUT_HOURS` | Hours after last sync that trigger auto-sync | `2` |
| `ADIT_AUTH_TOKEN` | Static JWT token for CI/CD or non-interactive auth | unset |
| `ADIT_PROJECT_LINK_AUTO_SYNC` | Set to `false` to disable project-link auto-sync | `true` |
| `ADIT_PROJECT_LINK_STALE_HOURS` | Project-link cache staleness threshold | `2` |
| `ADIT_DEBUG` | Enable debug output and the hook debug log (`$TMPDIR/adit-hook-debug.jsonl`, size-capped) | unset |
| `ADIT_CODEX_BIN` | Override Codex binary used by cloud coding commands | unset |
| `ADIT_INSTALL_DIR` | Override the upgrade install directory | unset |
| `ADIT_ALLOW_NATIVE_BUILD` | Allow native better-sqlite3 build when no prebuild is confirmed | unset |
| `ADIT_SKIP_NATIVE_PREBUILD_CHECK` | Bypass the native prebuild preflight check | unset |

## Development Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

Build a single package:

```bash
pnpm --filter @varveai/adit-core build
```

Run a single test file:

```bash
pnpm test -- packages/core/src/db/events.test.ts
```

## Requirements

- Node.js >= 22.0.0
- pnpm >= 11.0.0
- Git

`@varveai/adit-core` depends on `better-sqlite3` v13, which bundles prebuilt
binaries for all supported platforms inside the npm package, so no native
build toolchain or install-time binary download is needed.

## License

MIT
