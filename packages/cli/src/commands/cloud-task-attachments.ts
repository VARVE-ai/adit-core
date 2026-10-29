import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  uploadCloudTaskAttachment,
  type CloudClient,
  type CloudTaskAttachment,
} from "@varveai/adit-cloud";
import { describeFailure } from "./cloud-read-output.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSION = /^\.(png|jpe?g|webp|gif)$/i;
const DOCUMENT_EXTENSION = /^\.(md|txt|docx|pdf|html|htm)$/i;

// Match the image signatures accepted by the existing web attachment service.
function imageType(bytes: Uint8Array): string | null {
  const starts = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
    return "image/gif";
  if (
    starts([0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

export type PreparedTaskAttachment = { path: string; file: File };

export async function prepareTaskAttachments(
  paths: string[] = [],
  imagePaths: string[] = [],
): Promise<PreparedTaskAttachment[]> {
  for (const path of imagePaths) {
    if (!IMAGE_EXTENSION.test(extname(path)))
      throw new Error(
        `Unsupported image: ${path}. Use --file for MD, TXT, DOCX, PDF, HTML or HTM documents.`,
      );
  }
  const attachments: PreparedTaskAttachment[] = [];
  for (const path of new Set([...paths, ...imagePaths].map((value) => resolve(value)))) {
    const extension = extname(path);
    const image = IMAGE_EXTENSION.test(extension);
    if (!image && !DOCUMENT_EXTENSION.test(extension))
      throw new Error(
        `Unsupported attachment: ${path}. Use PNG, JPG, JPEG, WebP, GIF, MD, TXT, DOCX, PDF, HTML or HTM.`,
      );
    const limit = image ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
    const sizeError = `Attachment must be a file between 1 byte and ${image ? 10 : 20} MB: ${path}`;
    const handle = await open(path, "r").catch(() => {
      throw new Error(`Cannot read attachment: ${path}`);
    });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error(sizeError);
      // Bound the read even if a file grows after stat; keep the validated bytes for upload.
      const bytes = new Uint8Array(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (!length || length > limit) throw new Error(sizeError);
      const content = bytes.slice(0, length);
      const type = image
        ? imageType(content)
        : extension.toLowerCase() === ".pdf"
          ? "application/pdf"
          : "application/octet-stream";
      if (!type) throw new Error(`Invalid image content: ${path}`);
      attachments.push({ path, file: new File([content], basename(path), { type }) });
    } finally {
      await handle.close();
    }
  }
  return attachments;
}

export async function uploadTaskAttachments(
  client: CloudClient,
  taskId: string,
  files: PreparedTaskAttachment[],
) {
  const attachments: CloudTaskAttachment[] = [];
  const imagesOnly = files.every(({ file }) => file.type.startsWith("image/"));
  for (let index = 0; index < files.length; index++) {
    try {
      const { attachment } = await uploadCloudTaskAttachment(client, taskId, files[index].file);
      attachments.push(attachment);
    } catch (error) {
      const failure = describeFailure(error);
      const failedFile = files[index].path;
      const pendingFiles = files.slice(index).map((attachment) => attachment.path);
      return {
        ok: false as const,
        taskId,
        attachments,
        failedFile,
        pendingFiles,
        ...(imagesOnly ? { failedImage: failedFile, pendingImages: pendingFiles } : {}),
        error: failure.message,
        status: failure.status,
        code:
          failure.code ??
          (imagesOnly ? "TASK_IMAGE_UPLOAD_FAILED" : "TASK_ATTACHMENT_UPLOAD_FAILED"),
        recovery: `The task exists. Retry only the pending files with adit cloud tasks attach ${taskId} --file <path>. Identical uploads to this task are deduplicated.`,
      };
    }
  }
  return { ok: true as const, taskId, attachments };
}
