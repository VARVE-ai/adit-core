import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupStaleClaudeCloudSettings,
  ensurePersistentClaudeHooksInstalled,
  installClaudeHooks,
} from "./hooks-bootstrap.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-claude-hooks-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeClaudeCloudSettings(path: string, port: number): void {
  const command = `curl -sS --fail --max-time 3 -X POST -H 'content-type: application/json' --data-binary @- 'http://127.0.0.1:${port}/hook?from=adit-cloud-cli-${port}' >/dev/null || true`;
  writeFileSync(
    path,
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command,
                  timeout: 5000,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
}

function runShellCommand(command: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`command exited with code ${code ?? "unknown"}`));
      }
    });
    child.stdin.end(input);
  });
}

describe("installClaudeHooks", () => {
  it("removes managed temporary settings files on cleanup", () => {
    const dir = tempDir();
    try {
      const claudeDir = join(dir, ".claude");
      const baseSettingsPath = join(claudeDir, "settings.local.json");
      const managedSettingsPath = join(claudeDir, "adit-cloud-test.settings.local.json");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(baseSettingsPath, JSON.stringify({ model: "claude-sonnet" }, null, 2));

      const installed = installClaudeHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-cli-1234",
        settingsPath: managedSettingsPath,
      });

      expect(installed.settingsPath).toBe(managedSettingsPath);
      const managedSettingsText = readFileSync(managedSettingsPath, "utf8");
      const managedSettings = JSON.parse(managedSettingsText);
      const command = managedSettings.hooks.UserPromptSubmit[0].hooks[0].command as string;
      const statusLineCommand = managedSettings.statusLine.command as string;
      expect(managedSettings.hooks.SessionStart).toBeUndefined();
      expect(managedSettings.hooks.Notification).toHaveLength(1);
      expect(managedSettings.hooks.StopFailure).toHaveLength(1);
      expect(managedSettings.statusLine.refreshInterval).toBe(1);
      expect(managedSettingsText).toContain("claude-sonnet");
      expect(managedSettingsText).toContain("from=adit-cloud-cli-1234");
      expect(command).toMatch(/^node -e /u);
      expect(statusLineCommand).toMatch(/^node -e /u);
      expect(statusLineCommand).toContain("from=adit-cloud-cli-1234");
      expect(command).not.toContain("curl ");
      expect(command).not.toContain("||");
      expect(command).not.toContain("/dev/null");
      expect(statusLineCommand).not.toContain("curl ");
      expect(statusLineCommand).not.toContain("/dev/null");

      installed.cleanup();
      expect(existsSync(managedSettingsPath)).toBe(false);
      expect(existsSync(baseSettingsPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes only ADIT cloud SessionStart hooks", () => {
    const dir = tempDir();
    try {
      const claudeDir = join(dir, ".claude");
      const baseSettingsPath = join(claudeDir, "settings.local.json");
      const managedSettingsPath = join(claudeDir, "adit-cloud-test.settings.local.json");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(baseSettingsPath, JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{
                type: "command",
                command: "node relay from=adit-cloud-cli-9999",
                timeout: 10,
              }],
            },
            {
              hooks: [{ type: "command", command: "other-tool session-start", timeout: 10 }],
            },
          ],
        },
      }, null, 2));

      installClaudeHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-cli-1234",
        settingsPath: managedSettingsPath,
      });

      const managedSettings = JSON.parse(readFileSync(managedSettingsPath, "utf8"));
      expect(managedSettings.hooks.SessionStart).toHaveLength(1);
      expect(managedSettings.hooks.SessionStart[0].hooks[0].command).toBe(
        "other-tool session-start",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports status line model updates while preserving the original status line output", async () => {
    const dir = tempDir();
    let server: Server | null = null;
    const bodies: Array<Record<string, unknown>> = [];
    try {
      const claudeDir = join(dir, ".claude");
      const baseSettingsPath = join(claudeDir, "settings.local.json");
      const managedSettingsPath = join(claudeDir, "adit-cloud-test.settings.local.json");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        baseSettingsPath,
        JSON.stringify({
          statusLine: {
            type: "command",
            command: "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(d).model.display_name+' hud'))\"",
          },
        }, null, 2),
      );

      server = createServer((request, response) => {
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          raw += chunk;
        });
        request.on("end", () => {
          bodies.push(JSON.parse(raw));
          response.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(0, "127.0.0.1", () => {
          server?.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");

      installClaudeHooks({
        cwd: dir,
        endpoint: `http://127.0.0.1:${address.port}/hook`,
        marker: "from=adit-cloud-cli-1234",
        settingsPath: managedSettingsPath,
      });

      const managedSettings = JSON.parse(readFileSync(managedSettingsPath, "utf8"));
      const output = await runShellCommand(
        managedSettings.statusLine.command as string,
        JSON.stringify({
          model: {
            id: "glm-5.2[1M][1m]",
            display_name: "glm-5.2[1M][1m]",
          },
          effort: { level: "high" },
          session_id: "session-1",
          transcript_path: "/tmp/session-1.jsonl",
          cwd: dir,
        }),
      );

      expect(output).toBe("glm-5.2[1M][1m] hud");
      expect(bodies).toEqual([
        expect.objectContaining({
          hook_event_name: "StatusLine",
          event: "StatusLine",
          model: "glm-5.2[1M][1m]",
          activeModelId: "glm-5.2[1M][1m]",
          reasoningEffort: "high",
          session_id: "session-1",
          transcript_path: "/tmp/session-1.jsonl",
          cwd: dir,
          source: "statusLine",
        }),
      ]);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cleanupStaleClaudeCloudSettings", () => {
  it("removes inactive managed settings files and keeps active ones", async () => {
    const dir = tempDir();
    try {
      const claudeDir = join(dir, ".claude");
      const activePath = join(claudeDir, "adit-cloud-active.settings.local.json");
      const stalePath = join(claudeDir, "adit-cloud-stale.settings.local.json");
      const userSettingsPath = join(claudeDir, "settings.local.json");
      mkdirSync(claudeDir, { recursive: true });
      writeClaudeCloudSettings(activePath, 1234);
      writeClaudeCloudSettings(stalePath, 5678);
      writeFileSync(userSettingsPath, "{}");

      const removed = await cleanupStaleClaudeCloudSettings({
        cwd: dir,
        isPortActive: async (port) => port === 1234,
      });

      expect(removed).toContain(stalePath);
      expect(removed).not.toContain(activePath);
      expect(existsSync(activePath)).toBe(true);
      expect(existsSync(stalePath)).toBe(false);
      expect(existsSync(userSettingsPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes old managed settings files when no cloud hook port can be read", async () => {
    const dir = tempDir();
    try {
      const claudeDir = join(dir, ".claude");
      const oldPath = join(claudeDir, "adit-cloud-old.settings.local.json");
      const freshPath = join(claudeDir, "adit-cloud-fresh.settings.local.json");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(oldPath, "{ invalid json");
      writeFileSync(freshPath, "{ invalid json");
      const oldTime = new Date(Date.now() - 60_000);
      utimesSync(oldPath, oldTime, oldTime);

      const removed = await cleanupStaleClaudeCloudSettings({
        cwd: dir,
        maxAgeMs: 1_000,
      });

      expect(removed).toContain(oldPath);
      expect(removed).not.toContain(freshPath);
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(freshPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensurePersistentClaudeHooksInstalled", () => {
  it("installs persistent ADIT Claude hooks when missing", async () => {
    const dir = tempDir();
    try {
      const installed = await ensurePersistentClaudeHooksInstalled({
        cwd: dir,
        aditHookBinary: "node /tmp/adit-hook",
      });

      expect(installed).toBe(true);
      const settings = readFileSync(join(dir, ".claude", "settings.local.json"), "utf8");
      const fixedRootArg = `--project-root-b64 ${encodeProjectRoot(dir)}`;

      for (const hookType of ["prompt-submit", "stop"]) {
        expect(settings).toContain(
          `node /tmp/adit-hook --platform claude ${fixedRootArg} ${hookType}`,
        );
      }
      expect(settings).not.toContain(` ${fixedRootArg} session-end`);
      // notification / task-completed / subagent collection was retired
      expect(settings).not.toContain(` ${fixedRootArg} task-completed`);
      expect(settings).not.toContain(` ${fixedRootArg} notification`);
      expect(settings).not.toContain(` ${fixedRootArg} subagent-start`);
      expect(settings).not.toContain(` ${fixedRootArg} subagent-stop`);
      expect(existsSync(join(dir, ".claude", "commands", "adit.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not duplicate persistent Claude hooks when already installed", async () => {
    const dir = tempDir();
    try {
      await ensurePersistentClaudeHooksInstalled({
        cwd: dir,
        aditHookBinary: "node /tmp/adit-hook",
      });
      const installedAgain = await ensurePersistentClaudeHooksInstalled({
        cwd: dir,
        aditHookBinary: "node /tmp/adit-hook",
      });

      const settings = readFileSync(join(dir, ".claude", "settings.local.json"), "utf8");
      expect(installedAgain).toBe(false);
      // 5 hook mappings: prompt-submit, stop (Stop + StopFailure),
      // pre-tool-use + post-tool-use (Bash working-tree snapshots)
      expect((settings.match(/node \/tmp\/adit-hook/gu) ?? []).length).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function encodeProjectRoot(projectRoot: string): string {
  return Buffer.from(projectRoot, "utf8").toString("base64url");
}
