import type { ChildProcess } from "node:child_process";
import { killCliProcessTree } from "../cli-process.js";
export {
  decodeCsiUCode,
  isCsiUCtrlModifier,
  normalizeReclaimInput as normalizeCodexReclaimInput,
} from "../reclaim-input.js";

export const LOCAL_CLI_EXIT_WAIT_MS = 750;
export const LOCAL_CLI_FORCE_EXIT_WAIT_MS = 750;

export async function stopLocalCodexProcess(child: ChildProcess | null): Promise<boolean> {
  if (!child) return true;
  const exited = waitForChildExit(child, LOCAL_CLI_EXIT_WAIT_MS);
  killCliProcessTree(child);
  if (await exited) return true;

  const forceExited = waitForChildExit(child, LOCAL_CLI_FORCE_EXIT_WAIT_MS);
  killCliProcessTree(child, "SIGKILL");
  return forceExited;
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (exited: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}
