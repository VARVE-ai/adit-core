import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readCodexConfiguredModel,
  readCodexModelFromConfig,
  startCodexModelConfigWatcher,
} from "./codex-model-config-watcher.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-codex-model-config-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("condition timed out"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe("readCodexModelFromConfig", () => {
  it("reads only the top-level model value from Codex config TOML", () => {
    expect(readCodexModelFromConfig([
      "# user config",
      "model = \"gpt-5.5\" # selected in TUI",
      "[profiles.plan]",
      "model = \"gpt-5\"",
    ].join("\n"))).toBe("gpt-5.5");
  });

  it("ignores nested model values", () => {
    expect(readCodexModelFromConfig([
      "[profiles.plan]",
      "model = \"gpt-5\"",
    ].join("\n"))).toBeNull();
  });
});

describe("readCodexConfiguredModel", () => {
  it("prefers the user Codex config written by model selection", () => {
    const cwd = tempDir();
    const codexHome = tempDir();
    try {
      mkdirSync(join(cwd, ".codex"), { recursive: true });
      writeFileSync(join(cwd, ".codex", "config.toml"), "model = \"project-model\"\n");
      writeFileSync(join(codexHome, "config.toml"), "model = \"user-model\"\n");

      expect(readCodexConfiguredModel({ cwd, codexHome })).toBe("user-model");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe("startCodexModelConfigWatcher", () => {
  it("notices config.toml model changes without polling", async () => {
    const cwd = tempDir();
    const codexHome = tempDir();
    try {
      writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5.4\"\n");
      const models: string[] = [];
      const watcher = startCodexModelConfigWatcher({
        cwd,
        codexHome,
        debounceMs: 5,
        onModel: (model) => models.push(model),
      });
      try {
        expect(models).toEqual(["gpt-5.4"]);

        writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5.5\"\n");
        await waitFor(() => models.includes("gpt-5.5"));

        expect(models).toEqual(["gpt-5.4", "gpt-5.5"]);
      } finally {
        watcher.stop();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
