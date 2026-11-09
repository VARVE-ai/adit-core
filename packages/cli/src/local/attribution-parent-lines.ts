import { spawn } from "node:child_process";
import { normalizeLine } from "./attribution-evidence.js";

/** Stream parent content; retain only matching lines, never the whole repository. */
export function parentMatchingLines(
  repository: string,
  parent: string,
  paths: string[],
  wanted: Set<string>,
  signal?: AbortSignal,
  limits = { bytes: 512 * 1024 * 1024, line: 1024 * 1024, timeout: 60000 },
): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "--no-pager",
        "grep",
        "--threads=1",
        "--no-textconv",
        "-I",
        "-h",
        "-e",
        ".",
        parent,
        "--",
        ...paths,
      ],
      { cwd: repository, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal },
    );
    const matches = new Set<string>();
    let pending = "",
      bytes = 0,
      failure: Error | undefined;
    const fail = (reason: string) => {
      failure ??= new Error(reason);
      try {
        child.kill();
      } catch {
        /* Preserve the original diagnostic if termination is denied. */
      }
    };
    const timer = setTimeout(
      () => fail("Parent content analysis timed out; commit analysis remains pending"),
      limits.timeout,
    );
    const line = (text: string) => {
      const normalized = normalizeLine(text);
      if (wanted.has(normalized)) matches.add(normalized);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > limits.bytes) {
        fail("Parent content exceeds the analysis size limit; commit analysis remains pending");
        return;
      }
      pending += chunk;
      let start = 0,
        end: number;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        if (end - start > limits.line) {
          fail(
            "A parent text line exceeds the analysis size limit; commit analysis remains pending",
          );
          return;
        }
        line(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
      if (pending.length > limits.line)
        fail("A parent text line exceeds the analysis size limit; commit analysis remains pending");
    });
    child.stderr.resume(); // Do not retain or expose repository content in diagnostics.
    child.on("error", (error) => {
      failure ??= new Error(
        `Cannot read parent content (${(error as NodeJS.ErrnoException).code || "PROCESS_ERROR"})`,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 && code !== 1)
        reject(
          new Error(
            `Git parent content query failed (exit ${code}); commit analysis remains pending`,
          ),
        );
      else {
        if (pending) line(pending);
        resolve(matches);
      }
    });
  });
}
