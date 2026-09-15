import { describe, expect, it } from "vitest";
import { buildTestApp } from "../test/app.js";
import { createDiskStore } from "../lib/images.js";

describe("images plugin", () => {
  it("builds an S3 store from the config without touching the network", async () => {
    const app = await buildTestApp({ withDb: false, env: { IMAGE_STORE: "s3", IMAGE_BUCKET: "rch-images", AWS_REGION: "ap-south-1" } });
    await app.ready();
    expect(typeof app.images.put).toBe("function");
    await app.close();
  });

  it("builds a disk store by default", async () => {
    const app = await buildTestApp({ withDb: false });
    await app.ready();
    expect(await app.images.get(`items/none/${"c".repeat(64)}`)).toBeNull();
    await app.close();
  });

  it("uses an injected store as given", async () => {
    const { buildApp } = await import("../app.js");
    const { testConfig } = await import("../test/app.js");
    const store = createDiskStore("/nonexistent-rch");
    const app = await buildApp(testConfig(), { images: store });
    expect(app.images).toBe(store);
    await app.close();
  });
});
