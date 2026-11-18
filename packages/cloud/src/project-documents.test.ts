import { expect, it, vi } from "vitest";
import { uploadCloudProjectDocument } from "./project-documents.js";
import { CloudClient } from "./http/client.js";

it("sends local project identity and explicit scope through the authenticated CLI endpoint", async () => {
  const post = vi.spyOn(CloudClient.prototype, "post").mockResolvedValue({ status: "created" });
  const client = Object.create(CloudClient.prototype) as CloudClient;
  try {
    await uploadCloudProjectDocument(client, { teamId: "team", scope: "team", fileName: "Plan.md", content: "# Plan" });
    expect(post).toHaveBeenCalledWith("/api/cli/project-documents", { teamId: "team", scope: "team", localProjectId: undefined, fileName: "Plan.md", content: "# Plan" });
  } finally { post.mockRestore(); }
});
