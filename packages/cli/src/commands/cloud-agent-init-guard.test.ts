import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findGitRoot: vi.fn(),
  loadConfig: vi.fn(),
  projectNameFromRoot: vi.fn(),
  readWorkspaceManifest: vi.fn(),
  loadCredentials: vi.fn(),
  ensurePersistentClaudeHooksInstalled: vi.fn(),
  ensurePersistentCodexHooksInstalled: vi.fn(),
  resolveExecutable: vi.fn(),
  selectCodexExecutable: vi.fn(),
}));

vi.mock("@varveai/adit-core", () => ({
  ProjectManifestError: class ProjectManifestError extends Error {
    constructor(
      message: string,
      public readonly manifestPath: string,
    ) {
      super(message);
    }
  },
  findGitRoot: mocks.findGitRoot,
  loadConfig: mocks.loadConfig,
  projectNameFromRoot: mocks.projectNameFromRoot,
  readWorkspaceManifest: mocks.readWorkspaceManifest,
}));

vi.mock("@varveai/adit-cloud", () => {
  class CloudApiError extends Error {
    status = 500;
  }
  class CloudAuthError extends Error {}
  class CloudNetworkError extends Error {}
  return {
    CloudApiError,
    CloudAuthError,
    CloudClient: vi.fn(),
    CloudNetworkError,
    DEFAULT_SERVER_URL: "https://adit-cloud.example.test",
    loadCloudConfig: vi.fn(() => ({})),
    loadCredentials: mocks.loadCredentials,
  };
});

vi.mock("./cli-agent/claude/provider.js", () => ({
  ClaudeCodeProvider: class {},
}));

vi.mock("./cli-agent/cli-process.js", () => ({
  resolveExecutable: mocks.resolveExecutable,
  spawnCliProcess: vi.fn(),
}));

vi.mock("./cli-agent/claude/claude-transcript-sync.js", () => ({
  ClaudeTranscriptSync: class {},
}));

vi.mock("./cli-agent/codex/provider.js", () => ({
  CodexCliProvider: class {},
}));

vi.mock("./cli-agent/codex/codex-binary-resolver.js", () => ({
  codexBinaryMismatchDebugLines: vi.fn(() => []),
  selectCodexExecutable: mocks.selectCodexExecutable,
}));

vi.mock("./cli-agent/codex/codex-transcript-sync.js", () => ({
  CodexRelayEventDeduper: class {},
  CodexTranscriptSync: class {},
}));

vi.mock("./cli-agent/claude/hooks-bootstrap.js", () => ({
  cleanupStaleClaudeCloudSettings: vi.fn(),
  ensurePersistentClaudeHooksInstalled: mocks.ensurePersistentClaudeHooksInstalled,
  installClaudeHooks: vi.fn(),
}));

vi.mock("./cli-agent/codex/hooks-bootstrap.js", () => ({
  ensurePersistentCodexHooksInstalled: mocks.ensurePersistentCodexHooksInstalled,
  installCodexHooks: vi.fn(),
}));

vi.mock("./cli-agent/hook-server.js", () => ({
  startCliAgentHookServer: vi.fn(),
}));

vi.mock("./cli-agent/relay-client.js", () => ({
  CliAgentRelayWebSocket: class {},
}));

import { cloudClaudeCommand } from "./cloud-claude.js";
import { cloudCodexCommand } from "./cloud-codex.js";

describe("cloud agent initialization guard", () => {
  let projectRoot: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalAditDataDir: string | undefined;
  let originalAditDbPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    projectRoot = mkdtempSync(join(tmpdir(), "adit-cloud-uninit-"));
    mocks.findGitRoot.mockReturnValue(projectRoot);
    mocks.readWorkspaceManifest.mockReturnValue(null);
    mocks.projectNameFromRoot.mockReturnValue("project");
    mocks.loadConfig.mockImplementation(() => ({
      projectRoot,
      dataDir: join(projectRoot, ".adit"),
      dbPath: join(projectRoot, ".adit", "adit.sqlite"),
      clientId: "client",
      projectId: "",
      projectType: "repo",
      repositories: [],
      initialization: "uninitialized",
      captureEnv: true,
    }));
    mocks.resolveExecutable.mockReturnValue("/usr/local/bin/claude");
    mocks.selectCodexExecutable.mockReturnValue({
      bin: "codex",
      debugLines: [],
      executable: "/usr/local/bin/codex",
      source: "PATH",
      supportsAppServer: true,
    });
    originalAditDataDir = process.env.ADIT_DATA_DIR;
    originalAditDbPath = process.env.ADIT_DB_PATH;
    delete process.env.ADIT_DATA_DIR;
    delete process.env.ADIT_DB_PATH;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    if (originalAditDataDir === undefined) {
      delete process.env.ADIT_DATA_DIR;
    } else {
      process.env.ADIT_DATA_DIR = originalAditDataDir;
    }
    if (originalAditDbPath === undefined) {
      delete process.env.ADIT_DB_PATH;
    } else {
      process.env.ADIT_DB_PATH = originalAditDbPath;
    }
  });

  it("refuses cloud claude before project initialization side effects", async () => {
    await cloudClaudeCommand({ bin: "claude" });

    expect(process.exitCode).toBe(1);
    expect(mocks.loadCredentials).not.toHaveBeenCalled();
    expect(mocks.ensurePersistentClaudeHooksInstalled).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith([
      "ADIT is not initialized in this project.",
      "",
      "Run:",
      "  adit init",
      "",
      "Then retry:",
      "  adit cloud claude",
    ].join("\n"));
  });

  it("refuses cloud codex before project initialization side effects", async () => {
    await cloudCodexCommand({ bin: "codex" });

    expect(process.exitCode).toBe(1);
    expect(mocks.loadCredentials).not.toHaveBeenCalled();
    expect(mocks.ensurePersistentCodexHooksInstalled).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith([
      "ADIT is not initialized in this project.",
      "",
      "Run:",
      "  adit init",
      "",
      "Then retry:",
      "  adit cloud codex",
    ].join("\n"));
  });

  it("allows cloud codex from an initialized workspace root without a git repository", async () => {
    mocks.findGitRoot.mockReturnValue(null);
    mocks.readWorkspaceManifest.mockReturnValue({
      workspaceId: "workspace-id",
      createdAt: "2026-07-06T00:00:00.000Z",
    });
    mkdirSync(join(projectRoot, ".adit"), { recursive: true });
    writeFileSync(join(projectRoot, ".adit", "adit.sqlite"), "");
    mocks.loadConfig.mockReturnValue({
      projectRoot,
      dataDir: join(projectRoot, ".adit"),
      dbPath: join(projectRoot, ".adit", "adit.sqlite"),
      clientId: "client",
      projectId: "workspace-id",
      projectType: "workspace",
      repositories: [],
      initialization: "initialized",
      captureEnv: true,
    });
    mocks.loadCredentials.mockReturnValue(null);

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await cloudCodexCommand({ bin: "codex" });
    } finally {
      process.chdir(originalCwd);
    }

    expect(mocks.loadConfig).toHaveBeenCalled();
    expect(mocks.loadCredentials).toHaveBeenCalled();
    expect(mocks.ensurePersistentCodexHooksInstalled).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Not logged in. Run 'adit cloud login' first.");
  });
});
