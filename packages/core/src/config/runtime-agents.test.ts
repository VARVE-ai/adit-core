import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  readAgentRuntimeVersions,
  recordAgentRuntime,
} from "./runtime-agents.js";

it("records the loaded agent version until shutdown and ignores stale evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "adit-runtime-test-"));
  const cleanup = recordAgentRuntime(directory, "1.2.0");
  try {
    expect(readAgentRuntimeVersions(directory)).toEqual(["1.2.0"]);
    expect(readAgentRuntimeVersions(directory, Date.now() + 100_000)).toEqual(
      [],
    );
    cleanup();
    expect(readAgentRuntimeVersions(directory)).toEqual([]);
  } finally {
    cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("does not treat invalid runtime records as running agents", () => {
  const directory = mkdtempSync(join(tmpdir(), "adit-runtime-test-"));
  try {
    mkdirSync(join(directory, "runtime-agents"));
    writeFileSync(
      join(directory, "runtime-agents", "bad.json"),
      JSON.stringify({ pid: -1, version: "1.0.0", updatedAt: Date.now() }),
    );
    expect(readAgentRuntimeVersions(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
