import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { documentHistory, items } from "../../db/schema/index.js";
import { imageKey } from "../../lib/images.js";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "catalog_images" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

// u1 = counter at the Coffee Shop, u6 = counter at the Snack Kiosk, u2 = manager, u3 = store, u7 = admin.
const photo = (seed: number, size = 64) => { const b = new Uint8Array(size).fill(seed); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const hdr = async (id: string, key: string = randomUUID()) => ({ ...(await authHeaders(app, id)), "idempotency-key": key });
const setImg = async (it: string, who: string, bytes: Uint8Array, key?: string) =>
  app.inject({ method: "PUT", url: `/api/v1/items/${it}/image`, headers: await hdr(who, key), payload: { data: b64(bytes) } });
const delImg = async (it: string, who: string) =>
  app.inject({ method: "DELETE", url: `/api/v1/items/${it}/image`, headers: await hdr(who) });
const imageOf = async (it: string) => (await app.db.select({ image: items.image }).from(items).where(eq(items.key, it)))[0]?.image ?? null;

describe("setting an item's photo", () => {
  it("lets the manager set a photo on any item, and puts the hash on the wire", async () => {
    const bytes = photo(1);
    const r = await setImg("sand", "u2", bytes);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: { key: "sand", item: { n: "Veg sandwich", img: sha(bytes) } }, changed: ["items"], message: "Photo saved for Veg sandwich" });
    expect(await imageOf("sand")).toBe(sha(bytes));
    expect(await app.images.get(imageKey("sand", sha(bytes)))).toEqual({ bytes, contentType: "image/jpeg" });
    const trail = await app.db.select().from(documentHistory).where(eq(documentHistory.docId, "sand"));
    expect(trail.at(-1)).toMatchObject({ docType: "item", status: "Updated", who: "u2" });
  });

  it("lets a counter set a photo on its own outlet's menu", async () => {
    const r = await setImg("capp", "u1", photo(2));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().message).toBe("Photo saved for Cappuccino");
  });

  it("refuses a counter for a product its outlet does not list, and stores nothing", async () => {
    const bytes = photo(3);
    const r = await setImg("sand", "u1", bytes);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("Veg sandwich is not on the Coffee Shop menu - its photo is the manager's to set");
    expect(await app.images.get(imageKey("sand", sha(bytes)))).toBeNull();
  });

  it("is not there at all for the store keeper or the admin", async () => {
    expect((await setImg("capp", "u3", photo(4))).statusCode).toBe(404);
    expect((await setImg("capp", "u7", photo(4))).statusCode).toBe(404);
  });

  it("refuses a file that is not a photo, and one over 700 KB", async () => {
    const notPhoto = await setImg("capp", "u2", new TextEncoder().encode("<svg/>"));
    expect(notPhoto.statusCode).toBe(422);
    expect(notPhoto.json().error.message).toBe("That file is not a JPEG, PNG or WebP photo");
    const big = await setImg("capp", "u2", photo(5, 700_001));
    expect(big.statusCode).toBe(422);
    expect(big.json().error.message).toBe("The photo is 701 KB - the limit is 700 KB");
  });

  it("404s an unknown item", async () => {
    const r = await setImg("doesnotexist", "u2", photo(6));
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no item doesnotexist.");
  });

  it("refuses a retired item, but still lets its photo be removed", async () => {
    const bytes = photo(7);
    expect((await setImg("milk", "u2", bytes)).statusCode).toBe(200);
    await app.db.update(items).set({ active: false }).where(eq(items.key, "milk"));
    try {
      const r = await setImg("milk", "u2", photo(8));
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toMatch(/ is retired, so it takes no photo$/);
      const removed = await delImg("milk", "u2");
      expect(removed.statusCode, removed.body).toBe(200);
      expect(await imageOf("milk")).toBeNull();
    } finally {
      await app.db.update(items).set({ active: true }).where(eq(items.key, "milk"));
    }
  });

  it("replaces a photo and deletes the old object", async () => {
    const first = photo(9), second = photo(10);
    await setImg("chai", "u2", first);
    const r = await setImg("chai", "u2", second);
    expect(r.statusCode).toBe(200);
    expect(await imageOf("chai")).toBe(sha(second));
    expect(await app.images.get(imageKey("chai", sha(first)))).toBeNull();
    expect(await app.images.get(imageKey("chai", sha(second)))).not.toBeNull();
  });

  it("keeps the object when the same photo is sent again", async () => {
    const bytes = photo(11);
    await setImg("water", "u2", bytes);
    expect((await setImg("water", "u2", bytes)).statusCode).toBe(200);
    expect(await app.images.get(imageKey("water", sha(bytes)))).not.toBeNull();
  });

  it("replays a retried write instead of running it twice", async () => {
    const key = randomUUID();
    const a = await setImg("bisc", "u2", photo(12), key);
    const b = await setImg("bisc", "u2", photo(12), key);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
  });

  it("answers 503 when the store cannot take the photo, and changes nothing", async () => {
    const before = await imageOf("chips");
    const spy = vi.spyOn(app.images, "put").mockRejectedValueOnce(new Error("s3 down"));
    try {
      const r = await setImg("chips", "u2", photo(13));
      expect(r.statusCode).toBe(503);
      expect(r.json().error.message).toBe("The photo could not be stored just now - try again");
      expect(await imageOf("chips")).toBe(before);
    } finally { spy.mockRestore(); }
  });
});

describe("removing an item's photo", () => {
  it("clears the hash and the object", async () => {
    const bytes = photo(14);
    await setImg("juice", "u1", bytes);
    const r = await delImg("juice", "u1");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ changed: ["items"], message: "Photo removed from Real Juice 200ml" });
    expect(r.json().result.item.img).toBeUndefined();
    expect(await app.images.get(imageKey("juice", sha(bytes)))).toBeNull();
  });

  it("refuses an item with no photo, and a counter off its menu", async () => {
    const none = await delImg("juice", "u2");
    expect(none.statusCode).toBe(422);
    expect(none.json().error.message).toBe("Real Juice 200ml has no photo to remove");
    const off = await delImg("capp", "u6");
    expect(off.statusCode).toBe(403);
    expect(off.json().error.message).toBe("Cappuccino is not on the Snack Kiosk menu - its photo is the manager's to set");
  });
});

describe("GET /items/:it/image/:hash", () => {
  const read = (url: string) => app.inject({ method: "GET", url: `/api/v1${url}` });

  it("serves the current photo without a token, cached for a year and locked down", async () => {
    const bytes = photo(20);
    await setImg("capp", "u2", bytes);
    const r = await read(`/items/capp/image/${sha(bytes)}`);
    expect(r.statusCode).toBe(200);
    expect(new Uint8Array(r.rawPayload)).toEqual(bytes);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'");
  });

  it("404s an old hash, a malformed hash and an unknown item", async () => {
    const old = photo(21), next = photo(22);
    await setImg("chai", "u2", old);
    await setImg("chai", "u2", next);
    expect((await read(`/items/chai/image/${sha(old)}`)).statusCode).toBe(404);
    expect((await read(`/items/chai/image/nothex`)).statusCode).toBe(404);
    expect((await read(`/items/doesnotexist/image/${sha(next)}`)).statusCode).toBe(404);
  });

  it("404s when the row points at an object the store no longer has", async () => {
    const bytes = photo(23);
    await setImg("water", "u2", bytes);
    await app.images.delete(imageKey("water", sha(bytes)));
    expect((await read(`/items/water/image/${sha(bytes)}`)).statusCode).toBe(404);
  });
});
