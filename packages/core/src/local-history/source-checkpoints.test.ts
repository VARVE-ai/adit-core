import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceStamp } from "./source-checkpoints.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

afterEach(() => vi.restoreAllMocks());

it("detects same-size JSON companion edits even when filesystem timestamps are unchanged", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "adit-checkpoint-"));
  const path = join(dir, "state.json");
  try {
    fs.writeFileSync(path, JSON.stringify({ custom_title: "Initial" }));
    const stat = fs.lstatSync(path, { bigint: true });
    // Reproduce the timestamp collision deterministically on every platform.
    vi.mocked(fs.lstatSync).mockReturnValue(stat as never);
    const before = sourceStamp(path);
    expect(sourceStamp(path)).toBe(before);
    fs.writeFileSync(path, JSON.stringify({ custom_title: "Renamed" }));
    expect(sourceStamp(path)).not.toBe(before);
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
