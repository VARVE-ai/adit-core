import type { ChildProcess } from "node:child_process";
import {
  CLI_PROCESS_EXIT_WAIT_MS,
  stopCliProcessTreeAndWait,
  waitForCliProcessExit,
} from "../cli-process.js";
export {
  decodeCsiUCode,
  isCsiUCtrlModifier,
  normalizeReclaimInput as normalizeCodexReclaimInput,
} from "../reclaim-input.js";

export const LOCAL_CLI_EXIT_WAIT_MS = CLI_PROCESS_EXIT_WAIT_MS;

export async function stopLocalCodexProcess(child: ChildProcess | null): Promise<void> {
  await stopCliProcessTreeAndWait(child, LOCAL_CLI_EXIT_WAIT_MS);
}

export const waitForChildExit = waitForCliProcessExit;
