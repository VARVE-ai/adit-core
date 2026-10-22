import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSecrets } from "./secrets.js";
let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.skipIf(process.platform !== "win32")("round-trips a workspace Gist credential with DPAPI and clears it", async () => {
  root = mkdtempSync(join(tmpdir(), "adit-dpapi-"));
  const secrets = new LocalSecrets(root), workspace = "p_1234-abcd", fixture = "TEST_ONLY_GIST_CREDENTIAL";
  await secrets.save(workspace, fixture);
  expect(secrets.configured(workspace)).toBe(true);
  expect(readFileSync(join(root, "secrets", `${workspace}.dpapi`), "utf8")).not.toContain(fixture);
  expect(await secrets.read(workspace)).toBe(fixture);
  await expect(secrets.read("p_9876")).rejects.toThrow("Configure");
  secrets.clear(workspace); expect(secrets.configured(workspace)).toBe(false);
});
