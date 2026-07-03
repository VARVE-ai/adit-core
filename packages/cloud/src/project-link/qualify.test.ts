import { describe, expect, it, vi } from "vitest";

import type { CloudClient } from "../http/client.js";
import { checkQuality } from "./qualify.js";

describe("checkQuality", () => {
  it("includes repository identity when provided", async () => {
    const get = vi.fn().mockResolvedValue({
      qualified: true,
      score: 1,
      documentCount: 1,
      feedback: null,
    });
    const client = { get } as unknown as CloudClient;

    await checkQuality(client, "workspace-1", {
      localRepositoryId: "repo-1",
      relativePath: "packages/core",
    });

    expect(get).toHaveBeenCalledWith(
      "/api/project-link/qualify?localProjectId=workspace-1&localRepositoryId=repo-1&relativePath=packages%2Fcore",
    );
  });
});
