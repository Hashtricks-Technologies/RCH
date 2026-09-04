import { describe, expect, it } from "vitest";
import { seedReq, seedRsv, seedStock } from "@rch/contract/fixtures";
import { committed, freeToPromise } from "./promise";
describe("free to promise", () => {
  it("nets on-hand against open tickets and approved-but-unticketed requests", () => {
    const reqs = [{ st: "Manager approved" as const, ticket: null, lines: [{ it: "milk", qty: 5, appr: 4 }] }];
    expect(committed(reqs, "milk")).toBe(4);
    expect(freeToPromise(seedStock, seedRsv(), reqs, "store", "milk")).toBe(8);   // 12 on the shelf, none reserved, 4 already promised
    // The seed's one approved-but-unticketed request (REQ-2026-0910) is for sugar and butter;
    // the cup line on REQ-2026-0909 is already a ticket, so its 500 are reserved, not committed.
    expect(committed(seedReq, "milk")).toBe(0);
    expect(committed(seedReq, "sugar")).toBe(5);
    expect(committed(seedReq, "cup")).toBe(0);
    expect(seedRsv()["store:cup"]).toBe(500);
  });
});
