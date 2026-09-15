// The one module that touches photo bytes at rest. Two drivers behind one interface: S3 for every
// deployed process (config.ts refuses anything else in production), a folder for a laptop and the
// test suite. Keys are content-addressed, so writing the same photo twice writes the same object.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { sniffImageType, type ImageType } from "@rch/domain";

export type StoredImage = { bytes: Uint8Array; contentType: string };

export interface ImageStore {
  put(key: string, bytes: Uint8Array, contentType: ImageType): Promise<void>;
  /** `null` is "there is no such object", never a failure - a failure throws. */
  get(key: string): Promise<StoredImage | null>;
  /** Deleting what is already gone is not an error. */
  delete(key: string): Promise<void>;
}

/** An item key is whatever the store keeper typed (up to 64 characters), so it is encoded into
 *  one path segment - `encodeURIComponent` leaves dots alone, which would let `..` climb out of
 *  the disk store's folder, so those are encoded too. */
export const imageKey = (itemKey: string, hash: string): string =>
  `items/${encodeURIComponent(itemKey).replace(/\./g, "%2E")}/${hash}`;

export function createDiskStore(dir: string): ImageStore {
  const path = (key: string) => join(dir, ...key.split("/"));
  return {
    async put(key, bytes) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    },
    async get(key) {
      try {
        const bytes = new Uint8Array(await readFile(path(key)));
        // Only a checked photo was ever written here, so its own bytes say what it is.
        return { bytes, contentType: sniffImageType(bytes) ?? "application/octet-stream" };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async delete(key) { await rm(path(key), { force: true }); },
  };
}

export function createS3Store(client: S3Client, bucket: string): ImageStore {
  return {
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!r.Body) return null;
        return { bytes: await r.Body.transformToByteArray(), contentType: r.ContentType ?? "application/octet-stream" };
      } catch (err) {
        // NoSuchKey needs s3:ListBucket on the bucket; without it S3 answers AccessDenied for a
        // missing key, which this rethrows (RUNBOOK §16's policy grants ListBucket for that reason).
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}
