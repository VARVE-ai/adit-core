import { execFileSync, execSync } from "node:child_process";

export interface AditHookBinaryCheck {
  ok: boolean;
  detail: string;
}

export function checkAditHookBinary(
  aditHookBinary: string,
  opts: {
    platform?: NodeJS.Platform;
    exec?: typeof execSync;
    execFile?: typeof execFileSync;
  } = {},
): AditHookBinaryCheck {
  const platform = opts.platform ?? process.platform;
  const runCommand = opts.exec ?? execSync;
  const runFile = opts.execFile ?? execFileSync;

  try {
    runCommand(`${aditHookBinary} --help`, { timeout: 5000, stdio: "pipe" });
    return { ok: true, detail: `Available via ${aditHookBinary}` };
  } catch {
    // Fall through to PATH lookup below.
  }

  try {
    if (platform === "win32") {
      runFile("where", ["adit-hook"], { timeout: 3000, stdio: "pipe" });
    } else {
      runCommand("command -v adit-hook", { timeout: 3000, stdio: "pipe" });
    }
    return { ok: true, detail: `Available via ${aditHookBinary}` };
  } catch {
    return {
      ok: false,
      detail: "Not found. Ensure @varveai/adit-hooks is installed.",
    };
  }
}
