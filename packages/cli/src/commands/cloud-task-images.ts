import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { uploadCloudTaskImage, type CloudClient, type CloudTaskAttachment } from "@varveai/adit-cloud";
import { describeFailure } from "./cloud-read-output.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Match the image signatures accepted by the existing web attachment service.
function imageType(bytes: Uint8Array): string | null {
  const starts = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export type PreparedTaskImage = { path: string; file: File };

export async function prepareTaskImages(paths: string[] = []): Promise<PreparedTaskImage[]> {
  const images: PreparedTaskImage[] = [];
  for (const path of new Set(paths.map(value => resolve(value)))) {
    if (!/^\.(png|jpe?g|webp|gif)$/i.test(extname(path))) throw new Error(`Unsupported image: ${path}. Use PNG, JPG, JPEG, WebP or GIF.`);
    const handle = await open(path, "r").catch(() => { throw new Error(`Cannot read image: ${path}`); });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error(`Image must be a file between 1 byte and 10 MB: ${path}`);
      // Bound the read even if a file grows after stat; keep the validated bytes for upload.
      const bytes = new Uint8Array(MAX_IMAGE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (!length || length > MAX_IMAGE_BYTES) throw new Error(`Image must be between 1 byte and 10 MB: ${path}`);
      const content = bytes.slice(0, length);
      const type = imageType(content);
      if (!type) throw new Error(`Invalid image content: ${path}`);
      images.push({ path, file: new File([content], basename(path), { type }) });
    } finally { await handle.close(); }
  }
  return images;
}

export async function uploadTaskImages(client: CloudClient, taskId: string, images: PreparedTaskImage[]) {
  const attachments: CloudTaskAttachment[] = [];
  for (let index = 0; index < images.length; index++) {
    try {
      const { attachment } = await uploadCloudTaskImage(client, taskId, images[index].file);
      attachments.push(attachment);
    } catch (error) {
      const failure = describeFailure(error);
      return { ok: false as const, taskId, attachments, failedImage: images[index].path,
        pendingImages: images.slice(index).map(image => image.path),
        error: failure.message, status: failure.status, code: failure.code ?? "TASK_IMAGE_UPLOAD_FAILED",
        recovery: `The task exists. Retry only the pending images with adit cloud tasks attach ${taskId} --image <path>. Identical uploads to this task are deduplicated.` };
    }
  }
  return { ok: true as const, taskId, attachments };
}
