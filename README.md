# ADIT Core

**AI Development Intent Tracker — a flight recorder for AI-assisted development**

ADIT is a local-first recorder for AI-assisted development. It records
prompts, assistant responses, tool activity, per-turn file diffs, environment
snapshots, and cloud sync state so a project can be inspected and understood
with context instead of guesswork — locally via CLI/TUI, and optionally in
the adit-cloud Coding panel.

## What ADIT Does

1. **Trace every AI-assisted change** — ADIT stores normalized timeline events
   for user prompts, assistant turns, tools, subagents, notifications, diffs,
   and related metadata.
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
- **Coordinated cloud sync** — Auto-sync uploads Events, Sessions, and Diffs
  first, then refreshes Git metadata for linked projects. Manual sync also
  checks Git when conversation data is current. Project documents remain an
  explicit `adit cloud link` operation.
- **Platform session tracking** — Correlates ADIT records with platform-native
  session IDs.
- **Interactive TUI** — React/Ink terminal UI with timeline, detail, search,
  diff, and environment screens.
- **Fail-open hooks** — Hook errors are swallowed so ADIT never blocks the AI
  agent.

## Architecture

ADIT is a TypeScript pnpm monorepo with five packages:

| Package | Description |
| --- | --- |
| `@varveai/adit-core` | Core types, SQLite database access, config, sync primitives, and performance logs |
| `@varveai/adit-engine` | Git runner, working tree detection, timeline management, and environment capture/diff |
| `@varveai/adit-hooks` | Hook dispatcher, fail-open handlers, platform adapter registry, and hook install/validate/uninstall logic |
| `@varveai/adit-cli` | Commander.js CLI, cloud coding entry points, debug commands, and React/Ink TUI |
| `@varveai/adit-cloud` | Cloud config, device/token auth, HTTP client, incremental sync, project-link sync, and intent commands |

Package boundaries are intentionally small: `core` owns storage and shared
types, `engine` owns Git/timeline mechanics, `hooks` normalizes platform events,
`cli` owns user commands, and `cloud` owns remote sync.

## Platform Support

ADIT uses a pluggable adapter pattern. Each adapter maps platform-specific hook
events to ADIT's normalized hook model.

| Platform | Status | Integration |
| --- | --- | --- |
| Claude Code | Supported | Installs hook entries in `.claude/settings.local.json` and slash command files under `.claude/commands/` |
| Claude Code VS Code | Supported | Uses the Claude Code hook mechanism with VS Code-aware platform detection |
| OpenCode | Supported | Generates `.opencode/plugins/adit.ts`, slash commands, and LLM-callable tools `adit_link` and `adit_intent` |
| Cursor | Supported | Shares `.claude/settings.local.json`; platform is identified from Cursor payloads, not the model |
| Codex | Supported | Installs hook entries in `.codex/hooks.json`; approve them once inside Codex via `/hooks` (ADIT never edits the user-level Codex config) |
| Gemini CLI | Supported | Installs hook entries in `.gemini/settings.json` |
| GitHub Copilot | Stub | Detected by the registry, but hook install/parse support is not implemented yet |
| Other | Stub | Placeholder adapter for unknown platforms |

Registered adapters can be listed with:

```bash
adit hook list
```

### Shared Claude / Cursor hooks

`adit init` offers one **Claude Code / Cursor** option, including the Claude VS Code
extension. ADIT identifies `cursor_version` in each incoming payload and keeps
Cursor sessions and transcript parsing separate from Claude. Running Claude from
a Cursor terminal still records Claude.

Re-running `adit init` migrates project-local ADIT entries in `.cursor/hooks.json`
to the shared configuration, preserving other tools' hooks and settings. Legacy
`adit init --platform cursor` and `adit hook install cursor` use the shared installer.
Installing or removing any member affects the shared integration. Restart the AI
tool or open a new conversation after upgrading; stored session labels are not
rewritten. Cursor releases that do not load Claude-compatible hooks need upgrading.

### Cursor hooks on Windows

ADIT accepts UTF-8 BOM-prefixed hook input. Some Cursor versions also read their
UTF-8 hook payload files through Windows PowerShell 5.1 without specifying the
input encoding, corrupting non-ASCII text before ADIT receives it. For these
invocations, ADIT reads Cursor's still-live UTF-8 payload file from the current
user's temporary directory, matching the conversation, generation, hook event,
Cursor version, and session ID. This also covers Cursor loading Claude hooks.
No PowerShell upgrade, system locale change, or hook path change is required.

Recovery is limited to recent `cursor-hook-payload-*.json` files with bounded
file counts and sizes. ADIT never picks the newest conversation or guesses a
reverse encoding. If no unique matching payload is available, it falls back to
stdin; a future Cursor transport change may therefore require an adapter update.
Payload files remain owned and cleaned up by Cursor. Existing stored events are
not rewritten.

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

Every project represents a workspace directory, even when it contains only a
root Git repository. Project-level Git address and identity fields stay empty;
the root (`.`) and child repositories keep their own addresses and identities.
Cloud project names use the workspace directory name.

`adit init` writes `.adit/project.json`: a stable project identity and the
repositories included in that project. The root Git repository (`.`) and
immediate child repositories can be selected together, for example
`adit init --repos .,test2,test3`. There is no stored project type.

- **Parent and child projects coexist.** Running init in `test4/` creates or
  reuses its own project, whether or not the parent also includes that repository.
  Including a child never moves its data, changes its hooks, or hides its project.
- **Adding and excluding repositories.** Re-run init at the parent and select
  the current members. Exclusion stops repository uploads and removes this
  source's team mounts on the next successful link/sync. Historical records and
  the repository identity remain; re-inclusion reuses the identity but requires
  manual team mounting. Other projects and members are unaffected.
- **Sessions and documents.** A session stays with the project where it begins,
  including after working-directory changes or hook refreshes. Historical data
  stays in its original project. Documents synced from the same repository by
  two projects have independent versions. Root document discovery excludes
  nested Git repositories; each selected repository uploads its own documents.
- **Recovery.** Init saves the complete selection atomically. Interrupted runs
  can be retried without moving child data. Cloud applies saved revisions once
  and ignores stale retries. `--absorb` is no longer supported; `--detach` is a
  compatibility alias for ordinary independent initialization.
- **Older projects.** Explicit init upgrades the local manifest to schema 3 and
  restores a legacy merged child without changing its parent or moving history.
  Ordinary uploads never hide or restore projects. Install the matching Cloud
  version and apply its registration migration before using schema 3 clients.

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
| `adit cloud sync` | Push unsynced conversation records and always check linked Git metadata |
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
| `adit cloud tasks list --json` | Query your unfinished tasks using the current project's linked team, or its personal scope if no team is linked |
| `adit cloud tasks scopes --json` | List only the current project's accessible linked teams; use `tasks list --team <id>` if more than one is linked |
| `adit cloud tasks show <taskId> --json` | Read an assigned task, permissions and current update timestamp |
| `adit cloud tasks context <taskId> --json` | Read the task, current PRD and attachment/sketch URLs without downloading files |
| `adit cloud tasks update <taskId> --state done --json` | Update Cloud immediately and record task history |

`adit cloud link` supports `--force`, `--skip-docs`, `--skip-commits`,
`--dry-run`, and `--json`. The same project-link and intent
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

### Export, Debug, Maintenance

| Command | Description |
| --- | --- |
| `adit export event <id>` | Export one event as JSON |
| `adit export session [id]` | Export a session as JSON, JSONL, or Markdown |
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
local events with their related sessions and diffs. Manual sync always checks
Git metadata; auto-sync refreshes it after a conversation batch succeeds for
repositories previously connected by `adit cloud link`. Project documents
upload only when that command is run manually. Raw platform transcript files
and environment snapshots remain local. The login command prints exactly what
is uploaded and how to disable automatic sync; `adit status` surfaces sync
health warnings.

- Auto-sync runs after stable hook events when credentials are available.
- `prompt-submit` is skipped so cloud does not receive a half-finished turn.
- Each project tracks its own cursor with legacy global-cursor fallback.
- Count-based auto-sync defaults to 10 unsynced events.
- Time-based auto-sync defaults to 2 hours since the last successful sync.
- Session start initializes local attribution state but does not upload anything.
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
| `ADIT_DEBUG` | Enable debug output and the hook debug log (`$TMPDIR/adit-hook-debug.jsonl`, size-capped) | unset |
| `ADIT_CODEX_BIN` | Override Codex binary used by cloud coding commands | unset |
| `ADIT_INSTALL_DIR` | Override the upgrade install directory | unset |

## Reply Token Usage

Token totals are stored as numeric columns on the final reply event. The normal
sync request includes the reply's `tokenUsage` payload; late usage replays the
same event and requires a matching usage acknowledgement before marking it synced.
Per-request capture evidence stays private to the reply for deduplication and
exact request-time accounting. It is not emitted as additional timeline events.

The next database open adds the reply fields and drops `token_usage_records`,
`token_usage_sync_state`, and `token_usage_cursors`. Historical local token usage
is deliberately discarded, not migrated or reread from old transcripts. Existing
conversations, file changes, and usage already synced to Cloud remain intact.
Capture begins with subsequent prompts. Deploy a Cloud version that accepts
reply usage before upgrading Core; older Cloud versions leave usage pending
and report a missing acknowledgement rather than silently lose it.

## Task Skill

The `adit-tasks` skill is installed automatically by `adit init`, `adit upgrade`,
and published npm installs with lifecycle scripts enabled. It is placed in
`~/.agents/skills/adit-tasks/SKILL.md` and `~/.claude/skills/adit-tasks/SKILL.md`.
Already-running AI sessions may need restarting to discover it. Upgrades refresh
unmodified ADIT-owned copies; custom or unrelated existing skills are not overwritten.
If lifecycle scripts were disabled, run `adit init` to install the skill.

Ask your AI assistant "What tasks do I still need to finish?" and then select a
task to implement. The skill queries live data and keeps the real task ID,
reads the related PRD and directs the AI to read relevant resource URLs itself.
Independent tasks have no PRD and use their own requirements and attachments.
Both task listing and scope discovery send the current local project ID. Team
resolution reuses repository mounts, not all account memberships. One linked
team is selected automatically; several require choosing one of that project's
teams. Without a linked team, listing uses personal project tasks. Use
`--personal` to explicitly select personal tasks, or `--team <id>` to select a
linked team. Unrelated teams are rejected even if you belong to them. Responses
identify the source project and effective scope. Lists are paginated and return
`nextOffset`; changing pages must preserve the same project and scope.

"Work on this task" does not mark it completed. An explicit request to mark it
done runs an update, without requiring `adit cloud sync`. To postpone a task:

```bash
adit cloud tasks show <taskId> --json
adit cloud tasks update <taskId> --due 2026-09-30 --expected-updated-at <updatedAt> --json
```

Assignees may update their own state and due date; other edits retain existing
management permissions. A supplied stale `updatedAt` is rejected with HTTP 409;
without one, the CLI reads the current version before attempting the update.
Private resource URLs expire after 15 minutes and must not be published or
committed. Re-query context to refresh them. No task snapshots or attachment
files are cached by these commands. These commands require Cloud task API support.

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
