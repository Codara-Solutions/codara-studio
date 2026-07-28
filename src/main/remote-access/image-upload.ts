import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const MAX_REMOTE_IMAGE_BYTES = 12 * 1024 * 1024;
export const REMOTE_IMAGE_CHUNK_BYTES = 192 * 1024;
export const MAX_REMOTE_IMAGE_UPLOADS_PER_CONNECTION = 2;
export const MAX_REMOTE_IMAGE_BYTES_PER_CONNECTION = 128 * 1024 * 1024;
export const REMOTE_IMAGE_UPLOAD_IDLE_MS = 2 * 60 * 1000;

const REMOTE_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMOTE_IMAGE_PREFIX = "codara-phone-image-";
const IMAGE_EXTENSIONS = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

export interface RemoteImageUploadRequest {
  workspaceId: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface RemoteImageAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Absolute path on the paired computer. */
  path: string;
  /** The same path escaped for insertion into that computer's terminal. */
  inputToken: string;
}

export interface RemoteImageUploadHandle {
  write(data: Buffer): Promise<void>;
  finish(): Promise<RemoteImageAttachment>;
  abort(): Promise<void>;
}

export function isSupportedRemoteImageMimeType(value: string): boolean {
  return IMAGE_EXTENSIONS.has(value);
}

/**
 * Materialises one authenticated phone image in a private, server-selected
 * temp path. The caller owns sequencing and size accounting; this layer repeats
 * the exact-size check and validates the actual file signature before exposing
 * a terminal token.
 */
export async function createRemoteImageUpload(
  directory: string,
  input: RemoteImageUploadRequest,
  platform: NodeJS.Platform = process.platform,
): Promise<RemoteImageUploadHandle> {
  const extension = IMAGE_EXTENSIONS.get(input.mimeType);
  if (!extension) throw new Error("Unsupported image type.");
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`Images are limited to ${MAX_REMOTE_IMAGE_BYTES / 1024 / 1024} MB.`);
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${REMOTE_IMAGE_PREFIX}${Date.now()}-${randomUUID()}${extension}`);
  const file = await open(path, "wx+", 0o600);
  let written = 0;
  let closed = false;
  let finished = false;

  const closeAndRemove = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await file.close().catch(() => undefined);
    }
    if (!finished) await unlink(path).catch(() => undefined);
  };

  return {
    async write(data: Buffer): Promise<void> {
      if (closed || finished) throw new Error("This image upload is no longer open.");
      if (!Buffer.isBuffer(data) || data.length < 1) throw new Error("Image chunks cannot be empty.");
      if (written + data.length > input.size) {
        throw new Error("The image upload exceeded its declared size.");
      }
      let offset = 0;
      while (offset < data.length) {
        const result = await file.write(data, offset, data.length - offset, written + offset);
        if (result.bytesWritten < 1) throw new Error("The image could not be written.");
        offset += result.bytesWritten;
      }
      written += data.length;
    },

    async finish(): Promise<RemoteImageAttachment> {
      if (closed || finished) throw new Error("This image upload is no longer open.");
      if (written !== input.size) throw new Error("The image upload is incomplete.");

      const header = Buffer.alloc(Math.min(12, written));
      const read = await file.read(header, 0, header.length, 0);
      if (!matchesImageSignature(header.subarray(0, read.bytesRead), input.mimeType)) {
        await closeAndRemove();
        throw new Error("The selected file is not a valid supported image.");
      }

      await file.sync();
      closed = true;
      await file.close();
      finished = true;
      return {
        name: safeImageDisplayName(input.name, extension),
        mimeType: input.mimeType,
        size: written,
        path,
        inputToken: shellEscapePath(path, platform === "win32"),
      };
    },

    abort: closeAndRemove,
  };
}

/** Best-effort cleanup for images whose terminal sessions no longer need them. */
export async function pruneRemoteImageUploads(
  directory: string,
  now = Date.now(),
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.startsWith(REMOTE_IMAGE_PREFIX)) return;
      const path = join(directory, entry.name);
      const info = await stat(path).catch(() => null);
      if (!info || now - info.mtimeMs <= REMOTE_IMAGE_MAX_AGE_MS) return;
      await unlink(path).catch(() => undefined);
    }),
  );
}

function matchesImageSignature(header: Buffer, mimeType: string): boolean {
  if (mimeType === "image/jpeg") {
    return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return (
      header.length >= 8 &&
      header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (mimeType === "image/gif") {
    const signature = header.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return (
      header.length >= 12 &&
      header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

function safeImageDisplayName(value: string, extension: string): string {
  const leaf = basename(value || "phone-image", extname(value || ""));
  const stem = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .trim()
    .slice(0, 100);
  return `${stem || "phone-image"}${extension}`;
}

function shellEscapePath(path: string, isWindows: boolean): string {
  if (isWindows) return `"${path.replace(/"/g, '""')}"`;
  if (/[\r\n]/.test(path)) return `'${path.replace(/'/g, "'\\''")}'`;
  return path.replace(/[^A-Za-z0-9_./\-\u{0080}-\u{10FFFF}]/gu, "\\$&");
}
