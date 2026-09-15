import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createDiskStore, createS3Store, imageKey } from "./images.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const H = "b".repeat(64);

describe("imageKey", () => {
  it("files a photo under its item and its hash", () => {
    expect(imageKey("juice", H)).toBe(`items/juice/${H}`);
  });
  it("cannot be walked out of its folder by an odd item key", () => {
    expect(imageKey("../etc", H)).toBe(`items/%2E%2E%2Fetc/${H}`);
    expect(imageKey("a/b", H).split("/")).toHaveLength(3);
  });
});

describe("the disk store", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "rch-img-test-"));

  it("round-trips a photo and reads its type from the bytes", async () => {
    const store = createDiskStore(dir());
    await store.put(imageKey("juice", H), JPEG, "image/jpeg");
    expect(await store.get(imageKey("juice", H))).toEqual({ bytes: JPEG, contentType: "image/jpeg" });
  });

  it("answers null for a photo it never had, and deleting one is not an error", async () => {
    const d = dir();
    const store = createDiskStore(d);
    expect(await store.get(imageKey("juice", H))).toBeNull();
    await store.put(imageKey("juice", H), JPEG, "image/jpeg");
    await store.delete(imageKey("juice", H));
    await store.delete(imageKey("juice", H));
    expect(await store.get(imageKey("juice", H))).toBeNull();
    expect(readdirSync(join(d, "items"))).toEqual(["juice"]);
  });

  it("rethrows a read failure that is not a missing file", async () => {
    const d = dir();
    const store = createDiskStore(d);
    await store.put(imageKey("juice", H), JPEG, "image/jpeg");
    // A folder where the file should be: EISDIR, not ENOENT.
    await expect(store.get("items/juice")).rejects.toThrow();
  });
});

describe("the S3 store", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const client = () => new S3Client({ region: "ap-south-1", credentials: { accessKeyId: "x", secretAccessKey: "y" } });

  it("puts with the bucket, key and type", async () => {
    const c = client();
    const send = vi.spyOn(c, "send").mockResolvedValue({} as never);
    await createS3Store(c, "rch-images").put(`items/juice/${H}`, JPEG, "image/jpeg");
    const cmd = send.mock.calls[0]![0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({ Bucket: "rch-images", Key: `items/juice/${H}`, ContentType: "image/jpeg" });
  });

  it("reads the bytes and type back", async () => {
    const c = client();
    const send = vi.spyOn(c, "send").mockResolvedValue({ Body: { transformToByteArray: async () => JPEG }, ContentType: "image/jpeg" } as never);
    expect(await createS3Store(c, "rch-images").get(`items/juice/${H}`)).toEqual({ bytes: JPEG, contentType: "image/jpeg" });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(GetObjectCommand);
  });

  it("answers null for NoSuchKey or an empty body, and rethrows anything else", async () => {
    const c = client();
    const store = createS3Store(c, "rch-images");
    const send = vi.spyOn(c, "send");
    send.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "NoSuchKey" }));
    expect(await store.get("k")).toBeNull();
    send.mockResolvedValueOnce({} as never);
    expect(await store.get("k")).toBeNull();
    send.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    await expect(store.get("k")).rejects.toThrow("denied");
  });

  it("deletes by bucket and key", async () => {
    const c = client();
    const send = vi.spyOn(c, "send").mockResolvedValue({} as never);
    await createS3Store(c, "rch-images").delete("k");
    const cmd = send.mock.calls[0]![0] as DeleteObjectCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: "rch-images", Key: "k" });
  });
});
