import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  killCliProcessTree: vi.fn(),
}));

vi.mock("../cli-process.js", () => ({
  killCliProcessTree: (...args: unknown[]) => mocks.killCliProcessTree(...args),
}));

import {
  LOCAL_CLI_EXIT_WAIT_MS,
  LOCAL_CLI_FORCE_EXIT_WAIT_MS,
  stopLocalCodexProcess,
} from "./terminal.js";

function mockChildProcess(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.exitCode = null;
  child.signalCode = null;
  return child as unknown as ChildProcess;
}

describe("stopLocalCodexProcess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports success when the local process exits after termination", async () => {
    const child = mockChildProcess();
    const stopped = stopLocalCodexProcess(child);

    child.emit("exit", 0, null);

    await expect(stopped).resolves.toBe(true);
    expect(mocks.killCliProcessTree).toHaveBeenCalledTimes(1);
    expect(mocks.killCliProcessTree).toHaveBeenCalledWith(child);
  });

  it("forces termination when the local process ignores the first signal", async () => {
    vi.useFakeTimers();
    const child = mockChildProcess();
    const stopped = stopLocalCodexProcess(child);

    await vi.advanceTimersByTimeAsync(LOCAL_CLI_EXIT_WAIT_MS);
    expect(mocks.killCliProcessTree).toHaveBeenLastCalledWith(child, "SIGKILL");
    child.emit("exit", 0, null);

    await expect(stopped).resolves.toBe(true);
    expect(mocks.killCliProcessTree).toHaveBeenCalledTimes(2);
  });

  it("reports failure when the local process remains alive after both signals", async () => {
    vi.useFakeTimers();
    const child = mockChildProcess();
    const stopped = stopLocalCodexProcess(child);

    await vi.advanceTimersByTimeAsync(
      LOCAL_CLI_EXIT_WAIT_MS + LOCAL_CLI_FORCE_EXIT_WAIT_MS,
    );

    await expect(stopped).resolves.toBe(false);
    expect(mocks.killCliProcessTree).toHaveBeenCalledTimes(2);
  });
});
