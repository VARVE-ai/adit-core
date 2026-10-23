import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installCodexHooks,
} from "./hooks-bootstrap.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-codex-hooks-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Every test runs against a throwaway CODEX_HOME so the assertions can prove
// the user-level Codex config is never created or modified by ADIT.
let codexRoot: string;
let codexHome: string;
let userConfigPath: string;
let previousCodexHome: string | undefined;

beforeEach(() => {
  codexRoot = tempDir();
  codexHome = join(codexRoot, "codex-home");
  userConfigPath = join(codexHome, "config.toml");
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
  rmSync(codexRoot, { recursive: true, force: true });
});

describe("installCodexHooks", () => {
  it("keeps a persistent shared relay hook across individual CLI cleanup", () => {
    const dir = tempDir();
    try {
      const installed = installCodexHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
        persistent: true,
      });

      installed.cleanup();

      expect(readFileSync(installed.settingsPath, "utf8")).toContain(
        "from=adit-cloud-codex-test",
      );
      expect(existsSync(userConfigPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs relay hooks without touching project or user Codex config", () => {
    const dir = tempDir();
    try {
      const installed = installCodexHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      // No project config.toml — the hooks feature is default-enabled on
      // Codex >= 0.124 (ADIT's baseline).
      expect(existsSync(join(dir, ".codex", "config.toml"))).toBe(false);
      // No user config.toml — approval happens inside Codex, not via ADIT.
      expect(existsSync(userConfigPath)).toBe(false);
      expect(readFileSync(installed.settingsPath, "utf8")).toContain("UserPromptSubmit");
      const hooksConfig = JSON.parse(readFileSync(installed.settingsPath, "utf8"));
      expect(hooksConfig.hooks.SessionStart).toBeUndefined();
      const command = hooksConfig.hooks.UserPromptSubmit[0].hooks[0].command as string;
      expect(command).toMatch(/^node -e /u);
      expect(command).toContain("from=adit-cloud-codex-test");
      expect(command).not.toContain("curl ");
      expect(command).not.toContain("||");
      expect(command).not.toContain("/dev/null");
      expect(command).toContain("require('http')");
      expect(hooksConfig.hooks.Interrupt[0].hooks[0].timeout).toBe(3);
      expect(hooksConfig.hooks.Interrupt[0].hooks[0].command).toContain("timeout:2000");
      expect(hooksConfig.hooks.Interrupt[0].hooks[0].command).toContain("setTimeout(finish,2500)");
      expect(hooksConfig.hooks.Stop[0].hooks[0].timeout).toBe(30);
      expect(hooksConfig.hooks.Stop[0].hooks[0].command).toContain("setTimeout(finish,3500)");

      installed.cleanup();
      expect(existsSync(installed.settingsPath)).toBe(false);
      expect(existsSync(join(dir, ".codex", "config.toml"))).toBe(false);
      expect(existsSync(userConfigPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves existing project and user Codex configs byte-identical", () => {
    const dir = tempDir();
    try {
      const codexDir = join(dir, ".codex");
      const configPath = join(codexDir, "config.toml");
      const originalConfig = "model = \"gpt-5.5\"\n\n[features]\ncodex_hooks = true\nhooks = false\n";
      // Includes a trust block left behind by an older ADIT version — it
      // must survive install and cleanup untouched.
      const originalUserConfig = [
        "model = \"gpt-5.5\"",
        "",
        "# >>> adit-cloud-codex from=other-session",
        "[hooks.state.\"/tmp/other/hooks.json:stop:0:0\"]",
        "enabled = true",
        "trusted_hash = \"sha256:other\"",
        "# <<< adit-cloud-codex from=other-session",
        "",
      ].join("\n");
      mkdirSync(codexDir, { recursive: true });
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(configPath, originalConfig);
      writeFileSync(userConfigPath, originalUserConfig);

      const installed = installCodexHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
      expect(readFileSync(userConfigPath, "utf8")).toBe(originalUserConfig);

      installed.cleanup();
      expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
      expect(readFileSync(userConfigPath, "utf8")).toBe(originalUserConfig);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes only ADIT cloud SessionStart hooks", () => {
    const dir = tempDir();
    try {
      const codexDir = join(dir, ".codex");
      const hooksPath = join(codexDir, "hooks.json");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        hooksPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [{
                  type: "command",
                  command: "node relay from=adit-cloud-codex-test",
                  timeout: 30,
                }],
              },
              {
                hooks: [{ type: "command", command: "other-tool session-start", timeout: 30 }],
              },
            ],
          },
        }, null, 2) + "\n",
      );

      const installed = installCodexHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf8"));
      expect(hooksConfig.hooks.SessionStart).toHaveLength(1);
      expect(hooksConfig.hooks.SessionStart[0].hooks[0].command).toBe(
        "other-tool session-start",
      );

      installed.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps hook order stable when cloud hooks are reinstalled", async () => {
    const dir = tempDir();
    try {
      installCodexHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
        persistent: true,
      });
      mkdirSync(join(dir, ".codex"), { recursive: true });
      const mixed = JSON.parse(readFileSync(join(dir,".codex","hooks.json"),"utf8"));
      mixed.hooks.UserPromptSubmit.push({hooks:[{command:"node /tmp/adit-hook prompt-submit"}]});
      writeFileSync(join(dir,".codex","hooks.json"),JSON.stringify(mixed));

      installCodexHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:5678/hook",
        marker: "from=adit-cloud-codex-test",
        persistent: true,
      });

      const hooksPath = join(dir, ".codex", "hooks.json");
      const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf8"));
      const promptHooks = hooksConfig.hooks.UserPromptSubmit;
      expect(promptHooks).toHaveLength(2);
      expect(promptHooks[0].hooks[0].command).toContain("from=adit-cloud-codex-test");
      expect(promptHooks[1].hooks[0].command).toContain("node /tmp/adit-hook");
      expect(hooksConfig.hooks.SessionStart).toBeUndefined();

      expect(existsSync(userConfigPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps plugin Codex hooks and legacy user trust config after relay cleanup", () => {
    const dir = tempDir();
    try {
      const installed = installCodexHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      const hooksPath = join(dir, ".codex", "hooks.json");
      const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf8"));
      const pluginCommand = "CODEX=1 /usr/local/bin/adit-hook prompt-submit";
      hooksConfig.hooks.UserPromptSubmit.push({
        hooks: [{ type: "command", command: pluginCommand, timeout: 30 }],
      });
      writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n");

      mkdirSync(codexHome, { recursive: true });
      const legacyUserConfig =
        "# >>> adit-cloud-codex from=adit-cloud-codex-test\n"
        + `[hooks.state.${JSON.stringify(`${hooksPath}:user_prompt_submit:0:0`)}]\n`
        + "enabled = true\n"
        + "trusted_hash = \"sha256:cloud\"\n"
        + "# <<< adit-cloud-codex from=adit-cloud-codex-test\n"
        + "\n"
        + "# >>> adit-codex-hooks plugin\n"
        + "[hooks.state.\"/tmp/project/.codex/hooks.json:user_prompt_submit:1:0\"]\n"
        + "enabled = true\n"
        + "trusted_hash = \"sha256:plugin\"\n"
        + "# <<< adit-codex-hooks plugin\n";
      writeFileSync(userConfigPath, legacyUserConfig);

      installed.cleanup();

      const cleanedHooks = JSON.parse(readFileSync(hooksPath, "utf8"));
      expect(cleanedHooks.hooks.UserPromptSubmit).toHaveLength(1);
      expect(cleanedHooks.hooks.UserPromptSubmit[0].hooks[0].command).toBe(pluginCommand);

      // Residue from older versions is left alone — ADIT no longer edits it.
      expect(readFileSync(userConfigPath, "utf8")).toBe(legacyUserConfig);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a user-managed project config byte-identical through install and cleanup", () => {
    const dir = tempDir();
    try {
      const codexDir = join(dir, ".codex");
      const configPath = join(codexDir, "config.toml");
      const originalConfig = "[features]\nhooks = false\n";
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(configPath, originalConfig);

      const installed = installCodexHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      const hooksPath = join(dir, ".codex", "hooks.json");
      const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf8"));
      hooksConfig.hooks.UserPromptSubmit.push({
        hooks: [
          {
            type: "command",
            command: "CODEX=1 /usr/local/bin/adit-hook prompt-submit",
            timeout: 30,
          },
        ],
      });
      writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n");

      installed.cleanup();

      expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
      const cleanedHooks = JSON.parse(readFileSync(hooksPath, "utf8"));
      expect(cleanedHooks.hooks.UserPromptSubmit).toHaveLength(1);
      expect(cleanedHooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain("adit-hook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves existing user hook states untouched when installing", () => {
    const dir = tempDir();
    try {
      mkdirSync(codexHome, { recursive: true });
      const stateKey = join(dir, ".codex", "hooks.json") + ":post_tool_use:0:0";
      const originalUserConfig = [
        "[hooks.state]",
        "",
        `[hooks.state.${JSON.stringify(stateKey)}]`,
        "trusted_hash = \"sha256:stale\"",
        "",
      ].join("\n");
      writeFileSync(userConfigPath, originalUserConfig);

      const installed = installCodexHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      expect(readFileSync(userConfigPath, "utf8")).toBe(originalUserConfig);

      installed.cleanup();
      expect(readFileSync(userConfigPath, "utf8")).toBe(originalUserConfig);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
