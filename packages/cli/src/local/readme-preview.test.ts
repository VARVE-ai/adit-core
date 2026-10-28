import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LocalWorkspace } from "@varveai/adit-core";
import { readmePreview } from "./readme-preview.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it("uses the chosen workspace repository's actual README and keeps Markdown tables readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "adit-readme-"));
  roots.push(root);
  const a = join(root, "a"),
    b = join(root, "b");
  await mkdir(a);
  await mkdir(b);
  await writeFile(
    join(a, "README.md"),
    "# Actual project\n\n**Original summary**\n\nOriginal description.\n\n## Features\n\n1. **One** — original feature\n   continued.\n2. Two\n",
  );
  await writeFile(
    join(b, "README.md"),
    "# Other project\n\nOther description.\n\n## Areas\n\n| Name | Description |\n|---|---|\n| UI | Local preview |\n",
  );
  const workspace = {
    name: "workspace",
    repositories: [a, b],
  } as LocalWorkspace;
  expect(await readmePreview(workspace, a)).toMatchObject({
    title: "Actual project",
    introduction: ["Original summary", "Original description."],
    leadBold: true,
    sectionTitle: "Features",
    sectionItem: "One — original feature continued.",
  });
  expect(await readmePreview(workspace, b)).toMatchObject({
    title: "Other project",
    leadBold: false,
    sectionTable: [
      ["Name", "Description"],
      ["UI", "Local preview"],
    ],
    sectionItem: null,
  });
  await expect(readmePreview(workspace, root)).rejects.toThrow(
    "Repository is not in this workspace",
  );
  expect(await readmePreview({ ...workspace, repositories: [] })).toMatchObject(
    { title: "workspace", repository: null, introduction: [] },
  );
});
