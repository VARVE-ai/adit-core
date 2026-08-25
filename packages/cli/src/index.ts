#!/usr/bin/env node

/**
 * CLI entry shim.
 *
 * Checks the Node.js version before the real CLI is loaded, so users on
 * unsupported versions get a clear error instead of a syntax error or a
 * native-module (better-sqlite3) crash.
 *
 * `./main.js` must only be loaded via dynamic import: a static import
 * would be hoisted and executed before the version check runs.
 */

import {
  isSupportedNodeVersion,
  unsupportedNodeVersionMessage,
} from "./node-version.js";

if (!isSupportedNodeVersion(process.versions.node)) {
  console.error(unsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

(async () => {
  const { isCliEntrypoint } = await import("./entrypoint.js");
  if (!isCliEntrypoint(import.meta.url, process.argv[1])) return;

  const { parseProgram } = await import("./main.js");
  parseProgram();
})().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
