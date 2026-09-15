import { describe, expect, it } from "vitest";
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
