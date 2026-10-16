import { describe, expect, it } from "vitest";
import { findUntrustedCodexHookStates } from "./codex-trust.js";

const current = {
  key: "D:\\workersp\\adit\\.codex\\hooks.json:stop:1:0",
  trustedHash: "sha256:current",
};

function approval(key: string, hash = current.trustedHash, enabled?: boolean): string {
  return [
    `[hooks.state.'${key}']`,
    `trusted_hash = "${hash}"`,
    ...(enabled === undefined ? [] : [`enabled = ${enabled}`]),
  ].join("\n");
}

describe("Codex hook trust path matching", () => {
  it.skipIf(process.platform !== "win32").each([false, true])(
    "finds a current approval beside stale Windows casing records (reverse order: %s)",
    (reverse) => {
      const records = [approval(current.key.toLowerCase()), approval(current.key, "sha256:old")];
      if (reverse) records.reverse();
      expect(findUntrustedCodexHookStates(records.join("\n"), [current])).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "win32")("recognizes Windows path separators without changing event identity", () => {
    expect(findUntrustedCodexHookStates(
      approval(current.key.toLowerCase().replaceAll("\\", "/")), [current],
    )).toEqual([]);
  });

  it.each([
    { name: "changed content", key: current.key.toLowerCase(), hash: "sha256:old" },
    { name: "another project", key: current.key.replace("\\adit\\", "\\another\\") },
    { name: "another event", key: current.key.replace(":stop:", ":interrupt:") },
    { name: "another position", key: current.key.replace(":1:0", ":0:0") },
  ])("does not reuse an approval for $name", ({ key, hash }) => {
    expect(findUntrustedCodexHookStates(approval(key, hash), [current])).toEqual([current]);
  });

  it.skipIf(process.platform !== "win32").each([false, true])(
    "keeps an explicit disable effective across casing variants (reverse order: %s)",
    (reverse) => {
      const records = [approval(current.key.toLowerCase()), approval(current.key, current.trustedHash, false)];
      if (reverse) records.reverse();
      expect(findUntrustedCodexHookStates(records.join("\n"), [current])).toEqual([current]);
    },
  );

  it.skipIf(process.platform === "win32")("keeps case-sensitive paths distinct outside Windows", () => {
    const state = { ...current, key: "/work/Project/.codex/hooks.json:stop:1:0" };
    expect(findUntrustedCodexHookStates(approval(state.key.toLowerCase()), [state])).toEqual([state]);
  });
});
