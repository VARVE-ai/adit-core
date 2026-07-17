import { describe, it, expect } from "vitest";
import { normalizeMutationPaths } from "./path-normalize.js";
import type { AgentFileMutation } from "./types.js";

function mutation(path: string): AgentFileMutation {
  return {
    provider: "claude-code",
    toolUseId: "t1",
    toolName: "Edit",
    path,
    kind: "update",
    status: "completed",
    source: "claude-edit-tool",
  };
}

const ROOT = "/Users/dev/project";

describe("normalizeMutationPaths", () => {
  it("rewrites absolute paths inside the root to root-relative", () => {
    const [m] = normalizeMutationPaths([mutation("/Users/dev/project/src/app.ts")], {
      projectRoot: ROOT,
      cwd: ROOT,
    });
    expect(m.path).toBe("src/app.ts");
  });

  it("resolves cwd-relative paths (codex shell targets) against cwd, then the root", () => {
    const [m] = normalizeMutationPaths([mutation("utils/helper.ts")], {
      projectRoot: ROOT,
      cwd: "/Users/dev/project/src",
    });
    expect(m.path).toBe("src/utils/helper.ts");
  });

  it("keeps paths outside the project root absolute", () => {
    const [m] = normalizeMutationPaths([mutation("/tmp/scratch.txt")], {
      projectRoot: ROOT,
      cwd: ROOT,
    });
    expect(m.path).toBe("/tmp/scratch.txt");
  });

  it("normalizes Windows separators while relativizing", () => {
    const [m] = normalizeMutationPaths([mutation("/Users/dev/project\\src\\win.ts")], {
      projectRoot: ROOT,
      cwd: ROOT,
    });
    expect(m.path).toBe("src/win.ts");
  });

  it("returns the same object when the path is already root-relative", () => {
    const original = mutation("src/app.ts");
    const [m] = normalizeMutationPaths([original], { projectRoot: ROOT, cwd: ROOT });
    expect(m.path).toBe("src/app.ts");
    expect(m).toBe(original);
  });
});
