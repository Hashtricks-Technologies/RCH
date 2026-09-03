import { describe, expect, it } from "vitest";
import { seedReq, seedRsv, seedStock } from "@rch/contract/fixtures";
import { committed, freeToPromise } from "./promise";
describe("free to promise", () => {
  it("nets on-hand against open tickets and approved-but-unticketed requests", () => {
    const reqs = [{ st: "Manager approved" as const, ticket: null, lines: [{ it: "milk", qty: 5, appr: 4 }] }];
    expect(committed(reqs, "store", "milk")).toBe(4);
    expect(freeToPromise(seedStock, seedRsv(), reqs, "store", "milk")).toBe(12 - (seedRsv()["store:milk"] ?? 0) - 4);
    expect(committed(seedReq, "store", "milk")).toBe(seedReq.filter((r) => (r.st === "Manager approved" || r.st === "Partially approved") && !r.ticket).reduce((t, r) => t + r.lines.filter((l) => l.it === "milk").reduce((n, l) => n + l.appr, 0), 0));
  });
});
