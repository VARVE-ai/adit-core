import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTaskAttachments } from "./cloud-task-attachments.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "adit-attachments-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function file(name: string, bytes: string | Uint8Array) {
  const path = join(directory, name);
  writeFileSync(path, bytes);
  return path;
}

describe("task attachment preparation", () => {
  it.each(["md", "MD", "txt", "docx", "pdf", "html", "htm"])(
    "accepts Cloud's %s documents without changing their bytes",
    async (extension) => {
      const bytes = Buffer.from("# 原始资料\r\nDocument content\n");
      const path = file(`参考 文档.${extension}`, bytes);
      const [attachment] = await prepareTaskAttachments([path]);
      expect(attachment.path).toBe(path);
      expect(attachment.file.name).toBe(`参考 文档.${extension}`);
      expect(Buffer.from(await attachment.file.arrayBuffer())).toEqual(bytes);
      expect(attachment.file.type).toBe(
        extension === "pdf" ? "application/pdf" : "application/octet-stream",
      );
    },
  );

  it.each([
    ["png", "89504e470d0a1a0a", "image/png"],
    ["jpg", "ffd8ff", "image/jpeg"],
    ["jpeg", "ffd8ff", "image/jpeg"],
    ["webp", "524946460000000057454250", "image/webp"],
    ["gif", "474946383961", "image/gif"],
  ])("keeps %s image content validation for both flags", async (extension, signature, mimeType) => {
    const path = file(`image.${extension}`, Buffer.from(signature, "hex"));
    for (const [files, images] of [
      [[path], []],
      [[], [path]],
    ]) {
      const [attachment] = await prepareTaskAttachments(files, images);
      expect(attachment.file.type).toBe(mimeType);
    }
    const fake = file(`fake.${extension}`, "not an image");
    await expect(prepareTaskAttachments([fake])).rejects.toThrow("Invalid image content");
    await expect(prepareTaskAttachments([], [fake])).rejects.toThrow("Invalid image content");
  });

  it("accepts the exact image and document limits but rejects larger files and image flag misuse", async () => {
    const image = Buffer.alloc(10 * 1024 * 1024);
    image.set(Buffer.from("89504e470d0a1a0a", "hex"));
    const imagePath = file("limit.png", image);
    const documentPath = file("limit.md", Buffer.alloc(20 * 1024 * 1024, 32));
    const attachments = await prepareTaskAttachments([documentPath], [imagePath]);
    expect(attachments.map((attachment) => attachment.file.size)).toEqual([
      20 * 1024 * 1024,
      10 * 1024 * 1024,
    ]);
    await expect(
      prepareTaskAttachments([file("large.md", Buffer.alloc(20 * 1024 * 1024 + 1))]),
    ).rejects.toThrow("20 MB");
    await expect(
      prepareTaskAttachments([file("large.png", Buffer.alloc(10 * 1024 * 1024 + 1))]),
    ).rejects.toThrow("10 MB");
    await expect(prepareTaskAttachments([], [documentPath])).rejects.toThrow("Use --file");
  });

  it("rejects empty files, unreadable paths, directories and unsupported extensions", async () => {
    await expect(prepareTaskAttachments([file("empty.md", "")])).rejects.toThrow("1 byte");
    await expect(prepareTaskAttachments([join(directory, "missing.md")])).rejects.toThrow(
      "Cannot read attachment",
    );
    const folder = join(directory, "folder.md");
    mkdirSync(folder);
    await expect(prepareTaskAttachments([folder])).rejects.toThrow();
    for (const name of ["file.svg", "file.exe", "file.zip", "file.js", "file"]) {
      await expect(prepareTaskAttachments([file(name, "content")])).rejects.toThrow(
        "Unsupported attachment",
      );
    }
  });

  it("deduplicates resolved paths across file and image options", async () => {
    const path = file("same.png", Buffer.from("89504e470d0a1a0a", "hex"));
    const result = await prepareTaskAttachments([path, relative(process.cwd(), path)], [path]);
    expect(result).toHaveLength(1);
    expect(await prepareTaskAttachments()).toEqual([]);
  });
});
