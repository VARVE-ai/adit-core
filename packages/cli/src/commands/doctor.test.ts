import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadInitializedProjectConfig: vi.fn(),
  openDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  queryEvents: vi.fn(),
  listSessions: vi.fn(),
  endSession: vi.fn(),
  discoverWorkspaceRepositories: vi.fn(() => [] as Array<{ relativePath: string }>),
  getRemoteUrl: vi.fn(async () => "https://example.com/repo.git" as string | null),
  detectPlatform: vi.fn(),
  detectPlatforms: vi.fn(),
  getAdapter: vi.fn(),
  resolveAditHookBinary: vi.fn(),
  ensureConnectedPlatformsRecorded: vi.fn(async () => [] as string[]),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("@varveai/adit-core", () => ({
  openDatabase: mocks.openDatabase,
  closeDatabase: mocks.closeDatabase,
  queryEvents: mocks.queryEvents,
  listSessions: mocks.listSessions,
  endSession: mocks.endSession,
  discoverWorkspaceRepositories: mocks.discoverWorkspaceRepositories,
  projectManifestPath: (projectRoot: string) => `${projectRoot}/.adit/project.json`,
}));

vi.mock("@varveai/adit-engine", () => ({
  getRemoteUrl: mocks.getRemoteUrl,
}));

vi.mock("@varveai/adit-hooks/adapters", () => ({
  detectPlatform: mocks.detectPlatform,
  detectPlatforms: mocks.detectPlatforms,
  getAdapter: mocks.getAdapter,
  resolveAditHookBinary: mocks.resolveAditHookBinary,
}));

vi.mock("./project-initialization.js", () => ({
  loadInitializedProjectConfig: mocks.loadInitializedProjectConfig,
}));

vi.mock("./connected-platforms.js", () => ({
  ensureConnectedPlatformsRecorded: mocks.ensureConnectedPlatformsRecorded,
}));

import { doctorCommand } from "./doctor.js";
import { checkAditHookBinary } from "./doctor-hooks.js";

describe("doctorCommand", () => {
  let originalLog: typeof console.log;

  beforeEach(() => {
    vi.clearAllMocks();
    originalLog = console.log;
    console.log = vi.fn() as never;

    mocks.loadInitializedProjectConfig.mockReturnValue({
      projectRoot: "/repo",
      dataDir: "/repo/.adit",
      dbPath: "/repo/.adit/adit.sqlite",
      projectId: "project-1",
      projectType: "repo",
      clientId: "client-1",
      repositories: [{
        localRepositoryId: "project-1",
        relativePath: ".",
        displayName: "repo",
        repositoryUrl: null,
        canonicalRepoKey: null,
        path: "/repo",
      }],
    });
    mocks.openDatabase.mockReturnValue({
      pragma: vi.fn(() => [{ integrity_check: "ok" }]),
    });
    mocks.queryEvents.mockReturnValue([]);
    mocks.listSessions.mockReturnValue([]);
    mocks.getRemoteUrl.mockResolvedValue("https://example.com/repo.git");
    mocks.discoverWorkspaceRepositories.mockReturnValue([]);
    mocks.detectPlatforms.mockReturnValue([]);
    mocks.ensureConnectedPlatformsRecorded.mockResolvedValue([]);
    mocks.resolveAditHookBinary.mockReturnValue("adit-hook");
    mocks.detectPlatform.mockReturnValue("other");
    mocks.getAdapter.mockReturnValue({
      platform: "other",
      displayName: "Unknown Platform",
      hookMappings: [],
      validateInstallation: vi.fn(async () => ({
        valid: false,
        checks: [{
          name: "Unknown Platform support",
          ok: false,
          detail: "Unknown Platform adapter is not yet implemented",
        }],
      })),
      installHooks: vi.fn(),
    });
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("does not report fallback unknown platform as a fixable doctor issue", async () => {
    await doctorCommand();

    const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args.join(" "))
      .join("\n");

    expect(output).toContain("Hooks config: No platforms connected — run 'adit init'");
    expect(output).not.toContain("Unknown Platform settings");
    expect(output).not.toContain("Unknown Platform support");
  });

  it("checks manifest repositories and reports drift for multi-repo projects", async () => {
    mocks.loadInitializedProjectConfig.mockReturnValue({
      projectRoot: "/workspace",
      dataDir: "/workspace/.adit",
      dbPath: "/workspace/.adit/adit.sqlite",
      projectId: "workspace-1",
      projectType: "workspace",
      clientId: "client-1",
      repositories: [{
        localRepositoryId: "repo-api",
        relativePath: "api",
        displayName: "api",
        repositoryUrl: null,
        canonicalRepoKey: null,
        path: "/workspace/api",
      }],
    });
    mocks.discoverWorkspaceRepositories.mockReturnValue([
      { relativePath: "api" },
      { relativePath: "new-service" },
    ]);

    await doctorCommand();

    const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args.join(" "))
      .join("\n");

    expect(output).toContain("Project manifest: multi-repo · 1 repositories");
    // /workspace/api does not exist on disk — reported as drift, never auto-fixed
    expect(output).toContain("missing: api — run 'adit init' to update the list");
    expect(output).toContain("Unregistered repositories: new-service — run 'adit init' to add them");
    expect(output).not.toContain("git check skipped");
  });

  it("only reports hook adapters connected to the project", async () => {
    const claudeAdapter = {
      platform: "claude-code",
      displayName: "Claude Code",
      hookMappings: [{ platformEvent: "Stop", aditHandler: "stop" }],
      validateInstallation: vi.fn(async () => ({
        valid: true,
        checks: [{ name: "Hook configuration", ok: true, detail: "All hooks registered" }],
      })),
      installHooks: vi.fn(),
    };
    mocks.ensureConnectedPlatformsRecorded.mockResolvedValue(["claude-code"]);
    mocks.getAdapter.mockImplementation((platform: string) => {
      if (platform === "claude-code") return claudeAdapter;
      return {
        platform,
        displayName: "Codex",
        hookMappings: [{ platformEvent: "Stop", aditHandler: "stop" }],
        validateInstallation: vi.fn(async () => ({
          valid: false,
          checks: [{ name: "Hook configuration", ok: false, detail: "No hook configuration found" }],
        })),
        installHooks: vi.fn(),
      };
    });

    await doctorCommand();

    const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args.join(" "))
      .join("\n");

    expect(output).toContain("Hooks config: Claude Code: OK");
    expect(output).not.toContain("Codex:");
  });
});

describe("checkAditHookBinary", () => {
  it("runs the resolved command without Unix-only stderr redirection", () => {
    const exec = vi.fn();

    const result = checkAditHookBinary("adit-hook", { exec });

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith("adit-hook --help", {
      timeout: 5000,
      stdio: "pipe",
    });
  });

  it("uses where.exe fallback on Windows so npm .cmd shims are detected", () => {
    const exec = vi.fn(() => {
      throw new Error("not directly executable");
    });
    const execFile = vi.fn();

    const result = checkAditHookBinary("adit-hook", {
      platform: "win32",
      exec,
      execFile,
    });

    expect(result.ok).toBe(true);
    expect(execFile).toHaveBeenCalledWith("where", ["adit-hook"], {
      timeout: 3000,
      stdio: "pipe",
    });
  });

  it("uses command -v fallback on non-Windows platforms", () => {
    const exec = vi.fn((command: string) => {
      if (command === "adit-hook --help") {
        throw new Error("not directly executable");
      }
    });

    const result = checkAditHookBinary("adit-hook", {
      platform: "darwin",
      exec,
    });

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith("command -v adit-hook", {
      timeout: 3000,
      stdio: "pipe",
    });
  });
});
