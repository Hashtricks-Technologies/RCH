import { describe, expect, it } from "vitest";
import {
  ITEM_FIELD_FEATURES, mayEditItemField, unauthorisedItemFields, type ItemField, counterName, itemCodePrefix, nextItemCode,
  createTypeRefusal, isSellable, mayCreateType, MRP_MISSING_REFUSAL, neverSoldRefusal, unpricedRefusal,
  // ---- item photos ----
  mayEditItemImage, sniffImageType, checkPhoto, imageRetiredMessage, imageOffMenuMessage, imageNoneMessage,
  IMAGE_MAX_BYTES, IMAGE_NOT_PHOTO,
} from "./items.js";
import { routes, type Role } from "@rch/contract";
import { admits, DESK_DEFAULTS } from "./permissions.js";

const ALL_FIELDS: ItemField[] = ["n", "dn", "mrp", "cost", "gst", "hsn", "rl", "grp", "sl", "active", "src"];
const DESKS: readonly Role[] = ["counter", "manager", "store", "prod", "buyer"];
/** Who owned each field before roles were configurable, frozen: the seeded roles must reproduce it. */
const LEGACY_FIELD_DESKS: Readonly<Record<ItemField, readonly Role[]>> = {
  mrp: ["manager"], cost: ["manager"], gst: ["manager"], dn: ["manager"],
  n: ["store", "buyer", "prod"], hsn: ["store", "buyer", "prod"], rl: ["store", "buyer", "prod"],
  grp: ["store", "buyer", "prod"], sl: ["store", "buyer", "prod"], src: ["store", "buyer", "prod"],
  active: ["manager", "store", "buyer", "prod"],
  // Came after roles: whether a kitchen finished good is counted or on/off only is the kitchen's.
  onOff: ["prod"],
};
/** A seeded desk's permissions. */
const P = (d: Role) => DESK_DEFAULTS[d].perms;

describe("who owns which field on the item master", () => {
  it("gives the manager the three commercial figures and nothing else", () => {
    for (const f of ["mrp", "cost", "gst", "dn"] as const) expect(mayEditItemField(P("manager"), f)).toBe(true);
    expect(mayEditItemField(P("manager"), "mrp")).toBe(true);
    expect(mayEditItemField(P("manager"), "n")).toBe(false);
    expect(mayEditItemField(P("manager"), "hsn")).toBe(false);
    expect(mayEditItemField(P("manager"), "rl")).toBe(false);
    expect(mayEditItemField(P("manager"), "grp")).toBe(false);
  });

  it("gives the store, the buyer and the kitchen the six that describe the goods", () => {
    for (const role of ["store", "buyer", "prod"] as const) {
      expect(mayEditItemField(P(role), "n")).toBe(true);
      expect(mayEditItemField(P(role), "hsn")).toBe(true);
      expect(mayEditItemField(P(role), "rl")).toBe(true);
      expect(mayEditItemField(P(role), "grp")).toBe(true);
      expect(mayEditItemField(P(role), "sl")).toBe(true);
      expect(mayEditItemField(P(role), "src")).toBe(true);
      expect(mayEditItemField(P(role), "mrp")).toBe(false);
      expect(mayEditItemField(P(role), "cost")).toBe(false);
      expect(mayEditItemField(P(role), "gst")).toBe(false);
      expect(mayEditItemField(P(role), "dn")).toBe(false);
    }
  });

  it("lets all four retire a line, and the counter none of it", () => {
    for (const d of ["manager", "store", "buyer", "prod"] as const) expect(mayEditItemField(P(d), "active")).toBe(true);
    for (const f of ALL_FIELDS) expect(mayEditItemField(P("counter"), f)).toBe(false);
  });

  it("names the fields a role does not own, in the order the patch named them", () => {
    expect(unauthorisedItemFields(P("manager"), ["mrp", "cost", "gst", "active"])).toEqual([]);
    expect(unauthorisedItemFields(P("manager"), ["mrp", "n", "rl"])).toEqual(["n", "rl"]);
    expect(unauthorisedItemFields(P("store"), ["n", "mrp", "grp", "cost"])).toEqual(["mrp", "cost"]);
    expect(unauthorisedItemFields(P("counter"), ["active"])).toEqual(["active"]);
    expect(unauthorisedItemFields(P("buyer"), [])).toEqual([]);
  });

  it("splits the master in two with no field in both halves and none in neither", () => {
    // The two sentences the service gives depend on this: every field is either the manager's
    // or the three desks', and `active` is the one line both halves share.
    const commercial = ALL_FIELDS.filter((f) => mayEditItemField(P("manager"), f));
    const operational = ALL_FIELDS.filter((f) => mayEditItemField(P("store"), f));
    expect(commercial).toEqual(["dn", "mrp", "cost", "gst", "active"]);
    expect(operational).toEqual(["n", "hsn", "rl", "grp", "sl", "active", "src"]);
    expect(commercial.filter((f) => operational.includes(f))).toEqual(["active"]);
  });
});

describe("the item master's split, read from permissions", () => {
  it("puts the commercial half on items_stock, the operational half on item_master, and active on either", () => {
    expect(ITEM_FIELD_FEATURES.mrp).toEqual(["items_stock"]);
    expect(ITEM_FIELD_FEATURES.dn).toEqual(["items_stock"]);
    expect(ITEM_FIELD_FEATURES.hsn).toEqual(["item_master"]);
    expect(ITEM_FIELD_FEATURES.src).toEqual(["item_master"]);
    expect(ITEM_FIELD_FEATURES.active).toEqual(["items_stock", "item_master"]);
  });

  it("gives counted versus on/off only to the kitchen alone", () => {
    expect(ITEM_FIELD_FEATURES.onOff).toEqual(["make_distribute"]);
    expect(mayEditItemField(P("prod"), "onOff")).toBe(true);
    for (const d of ["counter", "manager", "store", "buyer"] as const) expect(mayEditItemField(P(d), "onOff")).toBe(false);
  });

  it("answers for a role's permissions, needing edit rather than view", () => {
    const commercial = { f: { items_stock: "edit" as const }, a: [] };
    const viewer = { f: { items_stock: "view" as const, item_master: "view" as const }, a: [] };
    const both = { f: { items_stock: "edit" as const, item_master: "edit" as const }, a: [] };
    expect(mayEditItemField(commercial, "mrp")).toBe(true);
    expect(mayEditItemField(commercial, "n")).toBe(false);
    expect(mayEditItemField(viewer, "active")).toBe(false);
    expect(unauthorisedItemFields(commercial, ["mrp", "n", "active", "hsn"])).toEqual(["n", "hsn"]);
    expect(unauthorisedItemFields(both, ["mrp", "n", "active", "hsn"])).toEqual([]);
  });

  it("gives every seeded role exactly the fields its desk owned before roles were configurable", () => {
    for (const role of DESKS) {
      for (const f of ALL_FIELDS) expect(mayEditItemField(P(role), f), `${role} ${f}`).toBe(LEGACY_FIELD_DESKS[f].includes(role));
    }
  });

  it("gives a photo to whoever holds item_photos at edit", () => {
    expect(mayEditItemImage({ f: { item_photos: "edit" }, a: [] })).toBe(true);
    expect(mayEditItemImage({ f: { menu: "edit" }, a: [] })).toBe(false);
    expect(mayEditItemImage(DESK_DEFAULTS.store.perms)).toBe(false);
  });
});

describe("item photos", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
  const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
  const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50);

  it("lets the manager and the counter set a photo, and nobody else", () => {
    expect(mayEditItemImage(P("manager"))).toBe(true);
    expect(mayEditItemImage(P("counter"))).toBe(true);
    for (const role of ["store", "buyer", "prod"] as const) expect(mayEditItemImage(P(role))).toBe(false);
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
    for (const role of DESKS) {
      expect(admits(routes.setItemImage.access, role, P(role)).ok).toBe(mayEditItemImage(P(role)));
      expect(admits(routes.removeItemImage.access, role, P(role)).ok).toBe(mayEditItemImage(P(role)));
    }
  });
});

describe("what a counter calls an item", () => {
  it("reads the display name where there is one, and the name otherwise", () => {
    expect(counterName({ n: "Britannia 50/50", dn: "50/50-5" })).toBe("50/50-5");
    expect(counterName({ n: "Britannia 50/50" })).toBe("Britannia 50/50");
    expect(counterName({ n: "Britannia 50/50", dn: "" })).toBe("Britannia 50/50");
  });
});

describe("the next item code", () => {
  it("is one past the highest code in the type's own series", () => {
    expect(nextItemCode("RAW", ["RM-1001", "RM-1009", "PK-2003", "MR-3004"])).toBe("RM-1010");
    expect(nextItemCode("PACK", ["RM-1001", "PK-2002"])).toBe("PK-2003");
    expect(nextItemCode("MRP", ["MR-3004"])).toBe("MR-3005");
    expect(nextItemCode("FG", ["FG-4003"])).toBe("FG-4004");
    expect(nextItemCode("MTO", ["MT-5002"])).toBe("MT-5003");
  });
  it("names each series by its prefix", () => {
    expect(["RAW", "PACK", "MRP", "FG", "MTO"].map((t) => itemCodePrefix(t as "RAW"))).toEqual(["RM", "PK", "MR", "FG", "MT"]);
  });
  it("starts each series at its first number", () => {
    expect(nextItemCode("RAW", [])).toBe("RM-1001");
    expect(nextItemCode("PACK", ["RM-1001"])).toBe("PK-2001");
    expect(nextItemCode("MTO", [])).toBe("MT-5001");
  });
  it("skips a code typed in another shape, and a low one never pulls the series back", () => {
    expect(nextItemCode("RAW", ["RM-10a", "rm-9000", "CHAI", "RM-12", "RM-1003"])).toBe("RM-1004");
    expect(nextItemCode("FG", ["FG-9999"])).toBe("FG-10000");
  });
});

describe("which desk adds which type to the master", () => {
  it("gives the store keeper all five, the kitchen what it makes and uses, procurement what it buys", () => {
    const types = ["RAW", "PACK", "MRP", "FG", "MTO"] as const;
    const of = (d: Role) => types.filter((t) => mayCreateType(d, t));
    expect(of("store")).toEqual(["RAW", "PACK", "MRP", "FG", "MTO"]);
    expect(of("prod")).toEqual(["RAW", "FG", "MTO"]);
    expect(of("buyer")).toEqual(["RAW", "PACK", "MRP"]);
    expect(of("manager")).toEqual([]);
    expect(of("counter")).toEqual([]);
  });

  it("names what the desk may add instead", () => {
    expect(createTypeRefusal("prod", "MRP")).toBe("Refused - the kitchen does not add printed-price (MRP) goods to the item master, only finished goods, made-to-order items and raw materials");
    expect(createTypeRefusal("buyer", "FG")).toBe("Refused - procurement does not add finished goods to the item master, only raw materials, packaging and printed-price (MRP) goods");
    expect(createTypeRefusal("manager", "RAW")).toBe("Refused - the outlet manager does not add raw materials to the item master, only nothing");
    expect(MRP_MISSING_REFUSAL).toBe("An MRP item needs the price printed on its pack");
  });
});

describe("what a counter sells", () => {
  it("sells MRP, FG and MTO lines and never a raw material or packing", () => {
    expect(["MRP", "FG", "MTO", "RAW", "PACK"].map((t) => isSellable(t as never))).toEqual([true, true, true, false, false]);
    expect(neverSoldRefusal("Milk", "RAW")).toBe("Refused - Milk is a raw material and is never sold at a counter");
    expect(neverSoldRefusal("Cup", "PACK")).toBe("Refused - Cup is packing and is never sold at a counter");
    expect(unpricedRefusal("Tea", "Restaurant")).toBe("Refused - give Tea a price at Restaurant before selling it there");
  });
});
