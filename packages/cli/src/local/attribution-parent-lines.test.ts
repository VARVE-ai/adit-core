import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parentMatchingLines } from "./attribution-parent-lines.js";

it("streams parent content beyond 64 MiB without dropping matching source lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-parent-stream-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe", encoding: "utf8" });
  try {
    git("init");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(root, "large.pen"), ("x".repeat(127) + "\n").repeat(530000));
    writeFileSync(join(root, "code.ts"), "export const sourceLine = true;\n");
    git("add", ".");
    git("-c", "core.hooksPath=NUL", "commit", "-m", "large parent");
    const wanted = new Set(["export const sourceLine = true;", "not in parent"]);
    expect(await parentMatchingLines(root, "HEAD", ["."], wanted)).toEqual(
      new Set(["export const sourceLine = true;"]),
    );
    await expect(
      parentMatchingLines(root, "HEAD", ["."], wanted, undefined, {
        bytes: 1024,
        line: 1024,
        timeout: 5000,
      }),
    ).rejects.toThrow(/size limit/);
    await expect(parentMatchingLines(root, "missing-commit", ["."], wanted)).rejects.toThrow(
      /Git parent content query failed/,
    );
    const abort = new AbortController();
    abort.abort();
    await expect(parentMatchingLines(root, "HEAD", ["."], wanted, abort.signal)).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
