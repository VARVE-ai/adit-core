/**
 * Node.js version gate for the CLI entry point.
 *
 * This module must stay import-free and syntactically conservative:
 * it runs before anything else so that unsupported Node.js versions
 * fail with a readable message instead of a native-module crash.
 *
 * Keep REQUIRED_NODE_MAJOR in sync with `engines.node` in package.json
 * and REQUIRED_NODE_MAJOR in install.sh.
 */

export const REQUIRED_NODE_MAJOR = 20;

export function isSupportedNodeVersion(version: string): boolean {
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) && major >= REQUIRED_NODE_MAJOR;
}

export function unsupportedNodeVersionMessage(version: string): string {
  return [
    `adit requires Node.js ${REQUIRED_NODE_MAJOR} or newer, but the current version is v${version}.`,
    "Upgrade Node.js (https://nodejs.org), then reinstall the CLI if it was installed with npm:",
    "  npm install -g @varveai/adit-cli",
  ].join("\n");
}
