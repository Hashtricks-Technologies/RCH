import { describe, expect, it } from "vitest";
import { ITEM_FIELD_ROLES, mayEditItemField, unauthorisedItemFields, type ItemField } from "./items.js";

const ALL_FIELDS: ItemField[] = ["n", "mrp", "cost", "gst", "hsn", "rl", "grp", "sl", "active"];

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

  it("gives the store, the buyer and the kitchen the five that describe the goods", () => {
    for (const role of ["store", "buyer", "prod"] as const) {
      expect(mayEditItemField(role, "n")).toBe(true);
      expect(mayEditItemField(role, "hsn")).toBe(true);
      expect(mayEditItemField(role, "rl")).toBe(true);
      expect(mayEditItemField(role, "grp")).toBe(true);
      expect(mayEditItemField(role, "sl")).toBe(true);
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
    expect(operational).toEqual(["n", "hsn", "rl", "grp", "sl", "active"]);
    expect(commercial.filter((f) => operational.includes(f))).toEqual(["active"]);
  });
});
