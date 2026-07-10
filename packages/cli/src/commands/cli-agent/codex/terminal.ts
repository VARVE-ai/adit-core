import type { ChildProcess } from "node:child_process";
import { killCliProcessTree } from "../cli-process.js";

export const LOCAL_CLI_EXIT_WAIT_MS = 750;

export async function stopLocalCodexProcess(child: ChildProcess | null): Promise<void> {
  if (!child) return;
  const exited = waitForChildExit(child, LOCAL_CLI_EXIT_WAIT_MS);
  killCliProcessTree(child);
  await exited;
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once("exit", finish);
    child.once("close", finish);
  });
}

export function normalizeCodexReclaimInput(text: string): string {
  return text
    .replace(/\x1b\[(\d+)(?:;([0-9:]+))?u/g, (_match, rawCode: string, rawModifier: string | undefined) =>
      decodeCsiUCode(Number(rawCode), rawModifier),
    )
    .replace(/\x1b\[(?:I|O)/g, "")
    .replace(/\x1b\[[?=>]?[0-9;:]*[A-Za-z~]/g, "");
}

export function decodeCsiUCode(code: number, rawModifier?: string): string {
  if (code === 99 && isCsiUCtrlModifier(rawModifier)) return "\u0003";
  if (code === 13) return "\n";
  if (code === 9) return "\t";
  if (code === 8 || code === 127) return "\b";
  if (code < 32 || !Number.isFinite(code)) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function isCsiUCtrlModifier(rawModifier: string | undefined): boolean {
  if (!rawModifier) return false;
  return rawModifier.split(":").includes("5");
}

export function applyReclaimText(buffer: string, text: string): string {
  let next = buffer;
  for (const char of text) {
    if (char === "\b" || char === "\x7f") {
      next = next.slice(0, -1);
    } else {
      next += char;
    }
  }
  return next;
}
