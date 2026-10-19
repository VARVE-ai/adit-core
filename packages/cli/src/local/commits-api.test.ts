import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLocalServer } from "./server.js";
let app: Awaited<ReturnType<typeof startLocalServer>>, root: string;
afterEach(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
it("authenticates commit routes, returns empty data and rejects unconfigured Git paths", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-commit-api-"));
  app = await startLocalServer({ directory: join(root, "state") });
  const w = app.store.saveWorkspace({
    path: root,
    repositories: [],
    providers: [],
  });
  for (const path of ["/commits", "/commits/sources"])
    expect(
      (await fetch(app.origin + "/api/local" + path + "?workspaceId=" + w.id))
        .status,
    ).toBe(401);
  const api = (path: string) =>
    fetch(app.origin + "/api/local" + path, {
      headers: { authorization: "Bearer " + app.token },
    });
  const response = await api("/commits?workspaceId=" + w.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    repositories: [],
    commits: [],
  });
  expect((await api("/commits?workspaceId=missing")).status).toBe(404);
  expect(
    (
      await api(
        `/commits/sources?workspaceId=${w.id}&repository=${encodeURIComponent(root)}&sha=${"a".repeat(40)}`,
      )
    ).status,
  ).toBe(400);
});
