import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  updateEnvironment,
  type UpdateInstallation,
  type UpdateManager,
} from "./auto-update-process.js";

const execute = promisify(execFile);
export type InstallationDetection = {
  installation?: UpdateInstallation;
  reason?: "disabled" | "source" | "unknown" | "permissions";
};

async function globalRoot(manager: UpdateManager): Promise<string> {
  const args =
    manager === "yarn"
      ? ["global", "dir"]
      : manager === "bun"
        ? ["pm", "-g", "bin"]
        : ["root", "-g"];
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : manager;
  const result = await execute(
    command,
    process.platform === "win32" ? ["/d", "/s", "/c", `${manager} ${args.join(" ")}`] : args,
    { timeout: 5000, windowsHide: true, maxBuffer: 65536, env: updateEnvironment() },
  );
  const path = result.stdout.trim();
  if (!isAbsolute(path) || /[\r\n]/.test(path)) throw new Error("Unknown global installation");
  if (manager === "yarn") return join(path, "node_modules");
  if (manager === "bun") return resolve(path, "../install/global/node_modules");
  return path;
}

export async function detectAutomaticInstallation(
  options: {
    entry?: string;
    env?: NodeJS.ProcessEnv;
    root?: (manager: UpdateManager) => Promise<string>;
  } = {},
): Promise<InstallationDetection> {
  const env = options.env ?? process.env;
  if (env.ADIT_DISABLE_AUTO_UPDATE === "1" || env.CI === "true" || env.CI === "1")
    return { reason: "disabled" };
  try {
    const entry = realpathSync(
      options.entry ?? fileURLToPath(new URL("../index.js", import.meta.url)),
    );
    const root = resolve(dirname(entry), "..");
    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (
      metadata.name !== "@varveai/adit-cli" ||
      !/^\d+\.\d+\.\d+$/.test(metadata.version) ||
      metadata.version === "0.0.0" ||
      /[/\\]packages[/\\]cli$/.test(root)
    )
      return { reason: "source" };
    const normalized = entry.replaceAll("\\", "/").toLowerCase();
    const manager: UpdateManager =
      normalized.includes("/pnpm/") || normalized.includes("/.pnpm/")
        ? "pnpm"
        : normalized.includes("/yarn/") || normalized.includes("/.yarn/")
          ? "yarn"
          : normalized.includes("/.bun/")
            ? "bun"
            : "npm";
    const global = realpathSync(await (options.root ?? globalRoot)(manager));
    const packagePath = join(global, "@varveai", "adit-cli");
    if (realpathSync(packagePath) !== root) return { reason: "unknown" };
    const location = relative(global, root);
    if (location.startsWith("..") || isAbsolute(location)) return { reason: "source" };
    if (manager !== "pnpm" && resolve(packagePath) !== root) return { reason: "source" };
    try {
      accessSync(root, constants.W_OK);
      accessSync(dirname(packagePath), constants.W_OK);
    } catch {
      return { reason: "permissions" };
    }
    if (process.getuid?.() === 0 || process.geteuid?.() === 0) return { reason: "permissions" };
    return {
      installation: { entry: join(packagePath, "dist", "index.js"), root: packagePath, manager },
    };
  } catch {
    return { reason: "unknown" };
  }
}
