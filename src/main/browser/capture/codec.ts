// Image encoding for the capture features. PNG and JPEG come from Electron's
// nativeImage; WebP has no encoder in the main process, so it is encoded by
// Chromium in Codara's own window (an OffscreenCanvas, which works while the
// window is hidden or minimized). Electron is required lazily so the pure
// parts load in unit suites.

import { getTrustedMainWindow } from "../../main-window-trust";
import type { Bitmap } from "./bitmap";

export type ImageFormat = "png" | "jpeg" | "webp";

export const MIME_TYPES: Record<ImageFormat, "image/png" | "image/jpeg" | "image/webp"> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const FILE_EXTENSIONS: Record<ImageFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };

/** Converts between encoded images and RGBA bitmaps: nativeImage in the app, a PNG library in tests. */
export interface BitmapCodec {
  decode(image: Buffer): Bitmap;
  encode(bitmap: Bitmap, format: ImageFormat, quality: number): Promise<Buffer>;
}

/** Swap the red and blue channels: nativeImage bitmaps are BGRA. */
export function swapRedBlue(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = data[i + 2];
    out[i + 1] = data[i + 1];
    out[i + 2] = data[i];
    out[i + 3] = data[i + 3];
  }
  return out;
}

export function nativeBitmapCodec(): BitmapCodec {
  const { nativeImage } = require("electron") as typeof import("electron");
  return {
    decode(image) {
      const decoded = nativeImage.createFromBuffer(image);
      const { width, height } = decoded.getSize();
      if (!width || !height) throw new Error("The captured image could not be decoded.");
      return { width, height, data: swapRedBlue(decoded.toBitmap()) };
    },
    async encode(bitmap, format, quality) {
      const image = nativeImage.createFromBitmap(Buffer.from(swapRedBlue(bitmap.data)), { width: bitmap.width, height: bitmap.height });
      if (format === "jpeg") return image.toJPEG(quality);
      const png = image.toPNG();
      return format === "webp" ? encodeWebp(png, quality) : png;
    },
  };
}

/** Re-encode a PNG as WebP in Codara's window. */
export async function encodeWebp(png: Buffer, quality: number): Promise<Buffer> {
  const window = getTrustedMainWindow();
  if (!window || window.isDestroyed()) throw new Error("WebP needs Codara's window to be open; use format jpeg.");
  const q = Math.max(0.01, Math.min(1, quality / 100));
  const script = `(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString("base64"))}), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: ${q} });
    if (blob.type !== "image/webp") throw new Error("this build has no WebP encoder");
    const out = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    return btoa(text);
  })()`;
  const encoded = (await window.webContents.executeJavaScript(script, false)) as unknown;
  if (typeof encoded !== "string" || !encoded) throw new Error("WebP encoding failed; use format jpeg.");
  return Buffer.from(encoded, "base64");
}
