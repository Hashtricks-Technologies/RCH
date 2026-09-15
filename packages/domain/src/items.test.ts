import { describe, expect, it } from "vitest";
import {
  ITEM_FIELD_ROLES, mayEditItemField, unauthorisedItemFields, type ItemField,
  // ---- item photos ----
  mayEditItemImage, sniffImageType, checkPhoto, imageRetiredMessage, imageOffMenuMessage, imageNoneMessage,
  IMAGE_MAX_BYTES, IMAGE_NOT_PHOTO,
} from "./items.js";
import { routes } from "@rch/contract";

const ALL_FIELDS: ItemField[] = ["n", "mrp", "cost", "gst", "hsn", "rl", "grp", "sl", "active", "src"];

describe("who owns which field on the item master", () => {
  it("gives the manager the three commercial figures and nothing else", () => {
    expect(ITEM_FIELD_ROLES.mrp).toEqual(["manager"]);
    expect(ITEM_FIELD_ROLES.cost).toEqual(["manager"]);
    expect(ITEM_FIELD_ROLES.gst).toEqual(["manager"]);
    expect(mayEditItemField("manager", "mrp")).toBe(true);
    expect(mayEditItemField("manager", "n")).toBe(false);
    expect(mayEditItemField("manager", "hsn")).toBe(false);
    expect(mayEditItemField("manager", "rl")).toBe(false);
    expect(mayEditItemField("manager", "grp")).toBe(false);
  });

  it("gives the store, the buyer and the kitchen the six that describe the goods", () => {
    for (const role of ["store", "buyer", "prod"] as const) {
      expect(mayEditItemField(role, "n")).toBe(true);
      expect(mayEditItemField(role, "hsn")).toBe(true);
      expect(mayEditItemField(role, "rl")).toBe(true);
      expect(mayEditItemField(role, "grp")).toBe(true);
      expect(mayEditItemField(role, "sl")).toBe(true);
      expect(mayEditItemField(role, "src")).toBe(true);
      expect(mayEditItemField(role, "mrp")).toBe(false);
      expect(mayEditItemField(role, "cost")).toBe(false);
      expect(mayEditItemField(role, "gst")).toBe(false);
    }
  });

  it("lets all four retire a line, and the counter none of it", () => {
    expect(ITEM_FIELD_ROLES.active).toEqual(["manager", "store", "buyer", "prod"]);
    for (const f of ALL_FIELDS) expect(mayEditItemField("counter", f)).toBe(false);
  });

  it("names the fields a role does not own, in the order the patch named them", () => {
    expect(unauthorisedItemFields("manager", ["mrp", "cost", "gst", "active"])).toEqual([]);
    expect(unauthorisedItemFields("manager", ["mrp", "n", "rl"])).toEqual(["n", "rl"]);
    expect(unauthorisedItemFields("store", ["n", "mrp", "grp", "cost"])).toEqual(["mrp", "cost"]);
    expect(unauthorisedItemFields("counter", ["active"])).toEqual(["active"]);
    expect(unauthorisedItemFields("buyer", [])).toEqual([]);
  });

  it("splits the master in two with no field in both halves and none in neither", () => {
    // The two sentences the service gives depend on this: every field is either the manager's
    // or the three desks', and `active` is the one line both halves share.
    const commercial = ALL_FIELDS.filter((f) => mayEditItemField("manager", f));
    const operational = ALL_FIELDS.filter((f) => mayEditItemField("store", f));
    expect(commercial).toEqual(["mrp", "cost", "gst", "active"]);
    expect(operational).toEqual(["n", "hsn", "rl", "grp", "sl", "active", "src"]);
    expect(commercial.filter((f) => operational.includes(f))).toEqual(["active"]);
  });
});

describe("item photos", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
  const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
  const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50);

  it("lets the manager and the counter set a photo, and nobody else", () => {
    expect(mayEditItemImage("manager")).toBe(true);
    expect(mayEditItemImage("counter")).toBe(true);
    for (const role of ["store", "buyer", "prod"] as const) expect(mayEditItemImage(role)).toBe(false);
  });

  it("knows a JPEG, a PNG and a WebP by their first bytes", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("refuses everything else, including a truncated header", () => {
    // SVG header
    expect(sniffImageType(bytes(0x3c, 0x73, 0x76, 0x67))).toBeNull(); // "<svg"
    // GIF header
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBeNull(); // "GIF89a"
    expect(sniffImageType(bytes())).toBeNull();
    expect(sniffImageType(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20))).toBeNull(); // RIFF AVI
  });

  it("checks size before type and answers in the operator's words", () => {
    expect(checkPhoto(JPEG)).toEqual({ ok: true, type: "image/jpeg" });
    expect(checkPhoto(bytes(1, 2, 3))).toEqual({ ok: false, refusal: "That file is not a JPEG, PNG or WebP photo" });
    expect(IMAGE_NOT_PHOTO).toBe("That file is not a JPEG, PNG or WebP photo");
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1); big.set(JPEG);
    expect(checkPhoto(big)).toEqual({ ok: false, refusal: "The photo is 701 KB - the limit is 700 KB" });
    const edge = new Uint8Array(IMAGE_MAX_BYTES); edge.set(JPEG);
    expect(checkPhoto(edge).ok).toBe(true);
  });

  it("names the item in each refusal", () => {
    expect(imageRetiredMessage("Veg sandwich")).toBe("Veg sandwich is retired, so it takes no photo");
    expect(imageOffMenuMessage("Veg sandwich", "Coffee Shop")).toBe("Veg sandwich is not on the Coffee Shop menu - its photo is the manager's to set");
    expect(imageNoneMessage("Veg sandwich")).toBe("Veg sandwich has no photo to remove");
  });

  it("agrees with the manifest about who reaches the photo doors", () => {
    for (const role of ["counter", "manager", "store", "prod", "buyer"] as const) {
      expect((routes.setItemImage.access as readonly string[]).includes(role)).toBe(mayEditItemImage(role));
      expect((routes.removeItemImage.access as readonly string[]).includes(role)).toBe(mayEditItemImage(role));
    }
  });
});
