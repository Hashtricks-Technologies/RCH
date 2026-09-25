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
  it("the kitchen switching an on/off item off takes it off every outlet, whatever the outlet's own switch says", () => {
    const off = { ok: false, mode: "Manual", why: "switched off by the kitchen" };
    expect(availOf(M, {}, {}, { "kitchen:meals": "switched off manually" }, "rest", "meals")).toEqual(off);
    expect(availOf(M, {}, {}, { "kitchen:meals": "switched off manually", "rest:meals": "switched off manually" }, "rest", "meals")).toEqual(off);
    expect(availOf(M, {}, {}, { "kitchen:meals": "switched off manually" }, "kitchen", "meals")).toEqual(off);
  });
  it("an outlet still switches an on/off item off for itself alone", () => {
    expect(availOf(M, {}, {}, { "rest:meals": "switched off manually" }, "rest", "meals")).toEqual({ ok: false, mode: "Manual", why: "switched off manually" });
    expect(availOf(M, {}, {}, { "rest:meals": "switched off manually" }, "kiosk", "meals")).toEqual({ ok: true, mode: "Manual" });
  });
  it("the kitchen's switch reaches no counter's own made-to-order drink and no counted good", () => {
    expect(availOf(M, {}, {}, { "kitchen:capp": "switched off manually" }, "coffee", "capp")).toEqual({ ok: true, mode: "Manual" });
    expect(availOf(M, seedStock, {}, { "kitchen:puff": "switched off manually" }, "rest", "puff")).toEqual({ ok: true, mode: "Stock", left: "12 nos" });
  });
});
