import { describe, expect, it, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
}));

import type { ChildProcess } from "node:child_process";
import {
  killCliProcessTree,
  pickExecutableCandidate,
  resolveExecutable,
  shouldUseWindowsShell,
  spawnCliProcess,
  taskkillTree,
} from "./cli-process.js";

const originalPlatform = process.platform;

afterEach(() => {
  vi.clearAllMocks();
  setPlatform(originalPlatform);
});

describe("cli process helpers", () => {
  it("prefers Windows cmd shims over extensionless npm shims", () => {
    setPlatform("win32");

    expect(pickExecutableCandidate("claude", [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.ps1",
    ])).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("prefers native Windows executables when available", () => {
    setPlatform("win32");

    expect(pickExecutableCandidate("codex", [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
      "C:\\Program Files\\Codex\\codex.exe",
    ])).toBe("C:\\Program Files\\Codex\\codex.exe");
  });

  it("resolves a command using where output on Windows", () => {
    setPlatform("win32");
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: [
        "C:\\Users\\me\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
    });

    expect(resolveExecutable("codex")).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd");
    expect(mocks.spawnSync).toHaveBeenCalledWith("where", ["codex"], expect.objectContaining({
      encoding: "utf8",
    }));
  });

  it("enables shell spawning for Windows cmd and bat shims", () => {
    setPlatform("win32");
    mocks.spawn.mockReturnValue({});

    expect(shouldUseWindowsShell("C:\\Tools\\claude.cmd")).toBe(true);
    expect(shouldUseWindowsShell("C:\\Tools\\codex.exe")).toBe(false);

    spawnCliProcess("C:\\Tools\\claude.cmd", ["--version"], {
      cwd: "C:\\project",
      stdio: "inherit",
    });

    // With shell:true the args are pre-joined into the command so Node's
    // unquoted concatenation (DEP0190) never sees a separate args array.
    expect(mocks.spawn).toHaveBeenCalledWith(
      "C:\\Tools\\claude.cmd --version",
      [],
      expect.objectContaining({
        cwd: "C:\\project",
        shell: true,
        windowsHide: true,
      }),
    );
  });

  it("quotes shell tokens containing spaces on Windows", () => {
    setPlatform("win32");
    mocks.spawn.mockReturnValue({});

    spawnCliProcess("C:\\Users\\John Doe\\claude.cmd", [
      "--settings",
      "C:\\Users\\John Doe\\proj\\.claude\\hooks.settings.local.json",
    ], { stdio: "inherit" });

    expect(mocks.spawn).toHaveBeenCalledWith(
      '"C:\\Users\\John Doe\\claude.cmd" --settings ' +
        '"C:\\Users\\John Doe\\proj\\.claude\\hooks.settings.local.json"',
      [],
      expect.objectContaining({ shell: true }),
    );
  });

  it("keeps args as an array for non-shell spawns", () => {
    setPlatform("win32");
    mocks.spawn.mockReturnValue({});

    spawnCliProcess("C:\\Tools\\codex.exe", ["resume", "abc"], { stdio: "inherit" });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "C:\\Tools\\codex.exe",
      ["resume", "abc"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("keeps args as an array on non-Windows platforms", () => {
    setPlatform("darwin");
    mocks.spawn.mockReturnValue({});

    spawnCliProcess("/usr/local/bin/claude", ["--resume", "abc"], {
      stdio: "inherit",
      shell: true,
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      ["--resume", "abc"],
      expect.objectContaining({ shell: true }),
    );
  });
});

describe("killCliProcessTree", () => {
  it("uses plain kill on non-Windows platforms", () => {
    setPlatform("darwin");
    const child = fakeChild();

    killCliProcessTree(child);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("kills the whole tree via taskkill on Windows", () => {
    setPlatform("win32");
    mocks.spawnSync.mockReturnValue({ status: 0 });
    const child = fakeChild();

    killCliProcessTree(child);

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "1234"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to plain kill when taskkill fails", () => {
    setPlatform("win32");
    mocks.spawnSync.mockReturnValue({ status: 128 });
    const child = fakeChild();

    killCliProcessTree(child);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("skips taskkill for a child that already exited", () => {
    setPlatform("win32");
    const child = fakeChild({ exitCode: 0 });

    killCliProcessTree(child);

    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("ignores missing children and bad pids", () => {
    setPlatform("win32");

    killCliProcessTree(null);
    expect(taskkillTree(undefined)).toBe(false);
    expect(taskkillTree(-1)).toBe(false);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});

function fakeChild(overrides: Partial<{
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}> = {}): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  return {
    pid: overrides.pid ?? 1234,
    exitCode: overrides.exitCode ?? null,
    signalCode: overrides.signalCode ?? null,
    kill: vi.fn(),
  } as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}
