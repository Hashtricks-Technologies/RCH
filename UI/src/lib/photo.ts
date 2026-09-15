import { API_PREFIX, itemImagePath } from "@rch/contract";
import { IMAGE_MAX_BYTES } from "@rch/domain";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
/** Longest edge of a stored photo: sharp on a card at any tablet width, tens of KB on the wire. */
const EDGE = 800;

/** Where an item's photo is read from - same origin as every API call, keyed on its hash. */
export const photoSrc = (it: string, hash: string): string => `${BASE}${API_PREFIX}${itemImagePath(it, hash)}`;

/** `btoa` takes a string of bytes; chunked so a large photo does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function encode(bitmap: ImageBitmap, quality: number): Promise<Uint8Array> {
  const scale = Math.min(1, EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0 + quality));
  if (!blob) throw new Error("the browser could not encode the photo");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The photo as it is sent: at most 800 px on its long edge, re-encoded as JPEG. Re-encoding is
 * also what strips the camera's EXIF block, GPS position included. `null` means the browser
 * could not read the file as a picture at all (a PDF, a HEIC it cannot decode).
 */
export async function shrinkPhoto(file: Blob): Promise<Uint8Array | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  try {
    const first = await encode(bitmap, 0.85);
    return first.length <= IMAGE_MAX_BYTES ? first : await encode(bitmap, 0.7);
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
