# AGENTS.md — ADIT Core Developer Guide

## Project Overview

ADIT Core is a TypeScript pnpm monorepo for a local-first flight recorder used
in AI-assisted development. The codebase records AI coding sessions, stores
timeline data in SQLite, creates Git-native checkpoints, installs platform
hooks, syncs optional cloud state, and generates planning/document artifacts.

Packages:

| Package | Responsibility |
| --- | --- |
| `@varveai/adit-core` | Types, SQLite persistence, config, sync primitives, redaction, performance logs, native install checks |
| `@varveai/adit-engine` | Git runner, checkpoint refs, temp-index snapshots, working tree detection, timeline manager, environment capture/diff |
| `@varveai/adit-hooks` | Hook dispatcher, platform adapters, normalized hook handlers, fail-open hook install/validate/uninstall |
| `@varveai/adit-cli` | Commander CLI, React/Ink TUI, cloud coding entry points, docs/debug/status/export commands |
| `@varveai/adit-cloud` | Device/token auth, HTTP client, incremental sync, transcript upload, project-link sync, intent commands |
| `@varveai/adit-plans` | SpecFlow-style plan manager and project document templates/validation |

## Build, Lint, And Test Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Build one package
pnpm --filter @varveai/adit-core build

# Type-check all packages
pnpm typecheck

# Type-check one package
pnpm --filter @varveai/adit-engine typecheck

# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run one test file
pnpm test -- packages/core/src/db/events.test.ts

# Run tests matching a name pattern
pnpm test -- --reporter=verbose -t "inserts and retrieves"

# Lint and format
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
```

Notes:

- `vitest.config.ts` includes `packages/*/src/**/*.test.ts` and
  `tests/**/*.test.ts`.
- No ESLint or Prettier config file is currently committed, so those scripts
  rely on installed tool defaults until configs are added.
- Package builds are `tsc` builds and emit `dist`, declarations, and source maps.

## TypeScript Configuration

All packages share `tsconfig.base.json`.

| Flag | Value | Implication |
| --- | --- | --- |
| `strict` | `true` | Full strict mode |
| `noUnusedLocals` | `true` | Remove or use every local binding |
| `noUnusedParameters` | `true` | Remove unused parameters or use `_name` only when the local pattern already does |
| `noFallthroughCasesInSwitch` | `true` | Switch cases need explicit return/break/throw |
| `module` / `moduleResolution` | `Node16` | Relative imports need `.js` extensions |
| `isolatedModules` | `true` | Use type-only imports for types; avoid module constructs that need cross-file transforms |
| `target` | `ES2022` | Modern JS features are available |
| `exactOptionalPropertyTypes` | `false` | Optional property semantics are not strict-exact |

## Code Style Guidelines

### Imports

- Use `.js` extensions on all relative imports:

  ```ts
  import { openDatabase } from "../db/connection.js";
  ```

- Use `import type` for type-only imports:

  ```ts
  import type { AditEvent } from "@varveai/adit-core";
  ```

- Group imports as external packages, then `@varveai/*` packages, then relative
  paths.
- Keep package APIs visible through `src/index.ts`, but avoid unnecessary
  re-export chains inside implementation files.

### Exports

- Use named exports in source files.
- Each package should expose its public API from `src/index.ts`.
- Avoid default exports in package source. The known exception is tooling config
  such as `vitest.config.ts`.

### Types

- Use `type` for unions and aliases:

  ```ts
  export type Actor = "A" | "U" | "T" | "S";
  ```

- Use `interface` for object shapes:

  ```ts
  export interface AditEvent {
    id: string;
  }
  ```

- Prefer `null` over `undefined` for optional database fields.
- Use `??` rather than `||` when falsy values like `0` or `""` are valid.
- Avoid non-null assertions except immediately after explicit checks.
- Avoid `any`; use `unknown` and narrow with guards.
- Use `readonly` for constructor or class properties that should not mutate.

### Naming

| Construct | Convention | Example |
| --- | --- | --- |
| Files | `kebab-case` | `working-tree.ts`, `auto-sync.test.ts` |
| Types/interfaces | `PascalCase` | `AditEvent`, `CloudConfig` |
| Functions/variables | `camelCase` | `createSnapshot`, `headSha` |
| Constants | Prefer `camelCase` unless a platform requires otherwise | `defaultBatchSize` |
| Factory functions | `createX(...)` | `createTimelineManager(db, config)` |
| Boolean flags | `isX` / `hasX` | `isExpired`, `hasCheckpoint` |

### Module Structure

- Keep one logical concern per file.
- Prefer a short module-level JSDoc comment for exported modules.
- Put type definitions and interfaces near the top.
- Put private helpers near the bottom.
- For stateful services, prefer factory functions returning typed interfaces
  when that matches the surrounding package style:

  ```ts
  export function createTimelineManager(
    db: Database,
    config: AditConfig,
  ): TimelineManager {
    // ...
  }
  ```

### Formatting

- 2-space indentation.
- Double quotes for strings.
- Trailing commas in multi-line arrays, objects, and parameter lists.
- Opening brace on the same line.
- Keep lines near 100 characters where practical.

## Error Handling

- Hooks must be fail-open. Catch errors, swallow them, and exit `0`; ADIT must
  never block the AI agent.
- Library code should not print noisy output. Use explicit return values or
  `process.stderr.write(...)` when diagnostics are necessary.
- Cloud code uses typed errors such as `CloudAuthError`, `CloudNetworkError`,
  and `CloudApiError`.
- Best-effort cleanup should use empty catches with a short comment:

  ```ts
  try {
    unlinkSync(path);
  } catch {
    /* best-effort */
  }
  ```

- SQLite and filesystem paths that can fail should return a sensible default,
  `null`, or a typed error path instead of crashing unrelated hook execution.

## Async And Performance

- Prefer `async`/`await` over `.then()` chains.
- Keep hook paths short and bounded. The hook dispatcher has a hard timeout and
  must not hang on stdin, Git, SQLite, or network operations.
- Performance-sensitive paths can use `withPerf`, `withPerfSync`, and
  `recordPerf` from `@varveai/adit-core`.

## Testing Conventions

Framework: Vitest with globals enabled.

- Test files are co-located with source as `foo.test.ts`.
- Use `describe()` and `it()` blocks.
- Name tests as behavior statements, for example `"inserts and retrieves an event"`.
- Build fixtures with `makeX(overrides)` helpers to avoid repetition.
- Prefer fresh temp directories and temp SQLite files per test.
- Clean up temp files in `afterEach`.

Database test pattern:

```ts
function tempDbPath(): string {
  return join(tmpdir(), `adit-test-${randomBytes(8).toString("hex")}.sqlite`);
}

beforeEach(() => {
  dbPath = tempDbPath();
  db = openDatabase(dbPath);
});

afterEach(() => {
  closeDatabase(db);
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort */
  }
});
```

Mocking pattern:

```ts
vi.mock("../config.js", () => ({ loadConfig: vi.fn() }));

import { loadConfig } from "../config.js";

const mockLoadConfig = vi.mocked(loadConfig);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});
```

## Architecture Constraints

1. **Git-native and non-polluting** — Checkpoints are stored in
   `refs/adit/checkpoints/<id>`, not normal branch history.
2. **Temporary index snapshots** — Snapshot creation uses a temporary
   `GIT_INDEX_FILE` and must not alter the user's staging area.
3. **ULID primary keys** — Records use `generateId()` from
   `@varveai/adit-core` sync primitives.
4. **Fail-open hook execution** — Recording, sync, and transcript upload errors
   must not block AI tool execution.
5. **Package boundaries** — Keep `@varveai/adit-engine` free of CLI concerns;
   keep `@varveai/adit-hooks` focused on normalization and dispatch; keep cloud
   transport in `@varveai/adit-cloud`; keep CLI presentation in
   `@varveai/adit-cli`.
6. **Platform adapters stay pluggable** — Add or change platform behavior through
   `PlatformAdapter` implementations in `packages/hooks/src/adapters/`.
7. **Cloud is optional** — Local timeline and checkpoint flows must keep working
   without credentials, network access, or adit-cloud availability.
8. **Secrets stay redacted** — Any new event capture or upload path must pass
   sensitive text through the content redaction layer where appropriate.

## Current Platform Adapter Status

| Platform | Status | Config path |
| --- | --- | --- |
| Claude Code | Supported | `.claude/settings.local.json` |
| Claude Code VS Code | Supported | `.claude/settings.local.json` |
| OpenCode | Supported | `.opencode/plugins/adit.ts` |
| Cursor | Supported | `.cursor/hooks.json` |
| Codex | Supported | `.codex/hooks.json` plus Codex hook trust config |
| Gemini CLI | Supported | `.gemini/settings.json` |
| GitHub Copilot | Stub | No implemented hook install path |
| Other | Stub | Placeholder |

Use these commands when touching adapter behavior:

```bash
adit hook list
adit hook install <platform>
adit hook validate <platform>
adit hook uninstall <platform>
```

## Data And Configuration

- Project data defaults to `.adit/`.
- SQLite database defaults to `.adit/adit.sqlite`.
- Machine client ID lives in `~/.adit/client-id`.
- Cloud credentials live in `~/.adit/cloud-credentials.json`.
- Project settings are read from `settings.json`.
- Environment variables override settings for data paths, cloud sync,
  transcript upload, project-link sync, Codex binary selection, and native build
  preflight behavior.
