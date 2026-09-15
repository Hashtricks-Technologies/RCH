import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES } from "@rch/domain";
import { photoSrc, shrinkPhoto, toBase64 } from "../lib/photo";

/** Vitest runs on Node, where `Buffer` is a real global - but this package's tsconfig
 *  deliberately excludes Node's ambient types (`types: ["vite/client"]`, so a browser build
 *  cannot see `setTimeout`'s Node overload by accident), so it is reached through a narrow
 *  local shape instead of widening that to the whole package. */
const nodeBuffer = (globalThis as unknown as {
  Buffer: { from(bytes: Uint8Array): { toString(encoding: string): string } };
}).Buffer;

describe("lib/photo", () => {
  it("builds the photo's URL under the API prefix", () => {
    const h = "d".repeat(64);
    expect(photoSrc("juice", h)).toBe(`/api/v1/items/juice/image/${h}`);
  });

  it("encodes bytes as base64, across chunk boundaries", () => {
    expect(toBase64(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("/9j/");
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(toBase64(big)).toBe(nodeBuffer.from(big).toString("base64"));
  });

  it("answers null when the browser cannot read the file as a picture", async () => {
    expect(await shrinkPhoto(new Blob(["not a picture"]))).toBeNull();
  });
});

/** jsdom implements a canvas element's `width`/`height` reflected attributes but not
 *  `getContext`/`toBlob` (those need the optional native `canvas` package), so `encode()`'s
 *  three real browser primitives are stubbed here rather than exercised for real. */
describe("lib/photo: shrinkPhoto's encode step", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const stubBitmap = (width: number, height: number) => {
    const close = vi.fn();
    return { bitmap: { width, height, close } as unknown as ImageBitmap, close };
  };

  /** `sizeAt(quality)` decides the encoded blob's byte length for a given JPEG quality, so a
   *  test can make the first pass (0.85) too big and force the retry at 0.7. */
  const stubCanvas = (sizeAt: (quality: number) => number) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback, _type?: string, quality?: number) => {
      cb(new Blob([new Uint8Array(sizeAt(quality ?? 1))]));
    });
  };

  /** The canvas `encode()` creates internally is a local variable - captured here by wrapping
   *  `document.createElement` so its `width`/`height` can be read back after the call. */
  const captureCanvas = () => {
    const real = document.createElement.bind(document);
    let captured: HTMLCanvasElement | undefined;
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = real(tag);
      if (tag === "canvas") captured = el as HTMLCanvasElement;
      return el;
    });
    return () => captured!;
  };

  it("scales a landscape photo down to 800px on its long edge", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(stubBitmap(1600, 800).bitmap));
    stubCanvas(() => 100);
    const canvas = captureCanvas();
    expect(await shrinkPhoto(new Blob(["x"]))).not.toBeNull();
    expect(canvas().width).toBe(800);
    expect(canvas().height).toBe(400);
  });

  it("scales a portrait photo down to 800px on its long edge", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(stubBitmap(600, 1200).bitmap));
    stubCanvas(() => 100);
    const canvas = captureCanvas();
    await shrinkPhoto(new Blob(["x"]));
    expect(canvas().width).toBe(400);
    expect(canvas().height).toBe(800);
  });

  it("never upscales a photo already smaller than the cap", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(stubBitmap(200, 100).bitmap));
    stubCanvas(() => 100);
    const canvas = captureCanvas();
    await shrinkPhoto(new Blob(["x"]));
    expect(canvas().width).toBe(200);
    expect(canvas().height).toBe(100);
  });

  it("floors a scaled dimension at 1px rather than rounding a thin edge to 0", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(stubBitmap(4000, 1).bitmap));
    stubCanvas(() => 100);
    const canvas = captureCanvas();
    await shrinkPhoto(new Blob(["x"]));
    expect(canvas().width).toBe(800);
    expect(canvas().height).toBe(1);
  });

  it("retries at a lower quality when the first pass is over the size limit", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(stubBitmap(800, 800).bitmap));
    const seenQualities: number[] = [];
    stubCanvas((quality) => {
      seenQualities.push(quality);
      return quality === 0.85 ? IMAGE_MAX_BYTES + 1 : IMAGE_MAX_BYTES - 1;
    });
    const out = await shrinkPhoto(new Blob(["x"]));
    expect(seenQualities).toEqual([0.85, 0.7]);
    expect(out).toHaveLength(IMAGE_MAX_BYTES - 1);
  });

  it("closes the bitmap even when the canvas has no 2d context", async () => {
    const { bitmap, close } = stubBitmap(800, 800);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(await shrinkPhoto(new Blob(["x"]))).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the bitmap and answers null when the browser refuses to encode the blob", async () => {
    const { bitmap, close } = stubBitmap(800, 800);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback) => cb(null));
    expect(await shrinkPhoto(new Blob(["x"]))).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
});
