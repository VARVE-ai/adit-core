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
import { describe, expect, it } from "vitest";
import {
  ensurePersistentCodexHooksInstalled,
  installCodexHooks,
} from "./hooks-bootstrap.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-codex-hooks-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("installCodexHooks", () => {
  it("installs relay hooks and trust state without touching project config", () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    try {
      const installed = installCodexHooks({
        cwd: dir,
        codexHome,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      const userConfig = readFileSync(join(codexHome, "config.toml"), "utf8");

      // No project config.toml — the hooks feature is default-enabled on
      // Codex >= 0.124 (ADIT's baseline).
      expect(existsSync(join(dir, ".codex", "config.toml"))).toBe(false);
      expect(readFileSync(installed.settingsPath, "utf8")).toContain("UserPromptSubmit");
      const hooksConfig = JSON.parse(readFileSync(installed.settingsPath, "utf8"));
      const command = hooksConfig.hooks.UserPromptSubmit[0].hooks[0].command as string;
      expect(command).toMatch(/^node -e /u);
      expect(command).toContain("from=adit-cloud-codex-test");
      expect(command).not.toContain("curl ");
      expect(command).not.toContain("||");
      expect(command).not.toContain("/dev/null");
      expect(command).toContain("require('http')");
      expect(userConfig).toContain("# >>> adit-cloud-codex from=adit-cloud-codex-test");
      expect(userConfig).toContain("[hooks.state.");
      expect(userConfig).toContain(".codex/hooks.json:post_tool_use:0:0");
      expect(userConfig).toContain("trusted_hash = \"sha256:");

      installed.cleanup();
      expect(() => readFileSync(join(dir, ".codex", "config.toml"), "utf8")).toThrow();
      expect(() => readFileSync(join(codexHome, "config.toml"), "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an existing project Codex config untouched", () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    try {
      const codexDir = join(dir, ".codex");
      const configPath = join(codexDir, "config.toml");
      const originalConfig = "model = \"gpt-5.5\"\n\n[features]\ncodex_hooks = true\nhooks = false\n";
      const userConfigPath = join(codexHome, "config.toml");
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
        codexHome,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
      expect(readFileSync(userConfigPath, "utf8")).toContain("# >>> adit-cloud-codex");

      installed.cleanup();
      expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
      expect(readFileSync(userConfigPath, "utf8")).toBe(originalUserConfig);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trusts cloud hooks at their final index when plugin hooks already exist", () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    try {
      const codexDir = join(dir, ".codex");
      const hooksPath = join(codexDir, "hooks.json");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        hooksPath,
        JSON.stringify(
          {
            hooks: {
              PostToolUse: [
                {
                  matcher: "Bash",
                  hooks: [
                    {
                      type: "command",
                      command: "CODEX=1 /usr/local/bin/adit-hook notification",
                      timeout: 30,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ) + "\n",
      );

      const installed = installCodexHooks({
        cwd: dir,
        codexHome,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      const userConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(userConfig).toContain(".codex/hooks.json:post_tool_use:1:0");
      expect(userConfig).not.toContain(".codex/hooks.json:post_tool_use:0:0");

      installed.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps plugin Codex hooks and removes only cloud trust after relay cleanup", () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    try {
      const installed = installCodexHooks({
        cwd: dir,
        codexHome,
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

      const userConfigPath = join(codexHome, "config.toml");
      writeFileSync(
        userConfigPath,
        `${readFileSync(userConfigPath, "utf8")}\n`
          + "# >>> adit-codex-hooks plugin\n"
          + "[hooks.state.\"/tmp/project/.codex/hooks.json:user_prompt_submit:1:0\"]\n"
          + "enabled = true\n"
          + "trusted_hash = \"sha256:plugin\"\n"
          + "# <<< adit-codex-hooks plugin\n",
      );

      installed.cleanup();

      const cleanedHooks = JSON.parse(readFileSync(hooksPath, "utf8"));
      expect(cleanedHooks.hooks.UserPromptSubmit).toHaveLength(1);
      expect(cleanedHooks.hooks.UserPromptSubmit[0].hooks[0].command).toBe(pluginCommand);

      const cleanedUserConfig = readFileSync(userConfigPath, "utf8");
      expect(cleanedUserConfig).not.toContain("adit-cloud-codex");
      expect(cleanedUserConfig).toContain("adit-codex-hooks plugin");
      expect(cleanedUserConfig).toContain(".codex/hooks.json:user_prompt_submit:1:0");
      expect(cleanedUserConfig).toContain("sha256:plugin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a user-managed project config byte-identical through install and cleanup", () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    try {
      const codexDir = join(dir, ".codex");
      const configPath = join(codexDir, "config.toml");
      const originalConfig = "[features]\nhooks = false\n";
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(configPath, originalConfig);

      const installed = installCodexHooks({
        cwd: dir,
        codexHome,
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

  it("replaces existing bare cloud trusted hook states when installing", () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    try {
      mkdirSync(codexHome, { recursive: true });
      const stateKey = join(dir, ".codex", "hooks.json") + ":post_tool_use:0:0";
      const tableHeader = `[hooks.state.${JSON.stringify(stateKey)}]`;
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          "[hooks.state]",
          "",
          tableHeader,
          "trusted_hash = \"sha256:stale\"",
          "",
        ].join("\n"),
      );

      const installed = installCodexHooks({
        cwd: dir,
        codexHome,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      const userConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(userConfig.split(tableHeader).length - 1).toBe(1);
      expect(userConfig).toContain("enabled = true");
      expect(userConfig).not.toContain("sha256:stale");

      installed.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensurePersistentCodexHooksInstalled", () => {
  it("installs persistent ADIT Codex hooks when missing", async () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      const installed = await ensurePersistentCodexHooksInstalled({
        cwd: dir,
        aditHookBinary: "node /tmp/adit-hook",
      });

      expect(installed).toBe(true);
      const hooks = readFileSync(join(dir, ".codex", "hooks.json"), "utf8");
      const userConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
      const fixedRootArg = `--project-root-b64 ${encodeProjectRoot(dir)}`;

      expect(hooks).toContain(
        `node /tmp/adit-hook --platform codex ${fixedRootArg} session-start`,
      );
      expect(hooks).toContain(
        `node /tmp/adit-hook --platform codex ${fixedRootArg} prompt-submit`,
      );
      expect(hooks).toContain(`node /tmp/adit-hook --platform codex ${fixedRootArg} stop`);
      expect(hooks).toContain(
        `node /tmp/adit-hook --platform codex ${fixedRootArg} notification`,
      );
      expect(existsSync(join(dir, ".codex", "config.toml"))).toBe(false);
      expect(userConfig).toContain("# >>> adit-codex-hooks project=");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not duplicate persistent hooks when already installed", async () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      await ensurePersistentCodexHooksInstalled({
        cwd: dir,
        aditHookBinary: "node /tmp/adit-hook",
      });
      const installedAgain = await ensurePersistentCodexHooksInstalled({
        cwd: dir,
        aditHookBinary: "node /tmp/adit-hook",
      });

      const hooks = readFileSync(join(dir, ".codex", "hooks.json"), "utf8");
      expect(installedAgain).toBe(false);
      expect((hooks.match(/node \/tmp\/adit-hook/gu) ?? []).length).toBe(4);
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function encodeProjectRoot(projectRoot: string): string {
  return Buffer.from(projectRoot, "utf8").toString("base64url");
}
