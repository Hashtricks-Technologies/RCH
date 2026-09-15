import { describe, expect, it } from "vitest";
import { IT, LOC, seedStock } from "@rch/contract/fixtures";
import { availOf } from "./availability";
const M = { items: IT, locations: LOC };
describe("availOf", () => {
  it("a manual override wins", () => { expect(availOf(M, seedStock, {}, { "coffee:capp": "switched off manually" }, "coffee", "capp")).toEqual({ ok: false, mode: "Manual", why: "switched off manually" }); });
  it("a made-to-order item holds no stock, so it is on until someone switches it off", () => {
    expect(availOf(M, {}, {}, {}, "coffee", "capp")).toEqual({ ok: true, mode: "Manual" });
  });
  it("a traded item is off at zero", () => { expect(availOf(M, seedStock, {}, {}, "kiosk", "juice")).toEqual({ ok: true, mode: "Stock", left: "14 nos" }); expect(availOf(M, seedStock, {}, {}, "coffee", "milk")).toEqual({ ok: false, mode: "Stock", why: "zero at this location" }); });
});
