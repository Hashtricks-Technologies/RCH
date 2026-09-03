import { describe, expect, it, vi } from "vitest";
import { resolveClaim, type ClaimRow } from "./idempotency-claim.js";

const HASH = "hash-a";
const NOW = 1_000_000;
const STALE_MS = 120_000;

function row(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return { requestHash: HASH, statusCode: 0, response: null, createdAt: new Date(NOW), ...overrides };
}

/** Queues canned results for the three ops so a test can spell out a sequence like
 *  "[conflict, lookup missing, insert ok]" and assert exactly how many times each was called. */
function ops(seq: { tryInsert?: boolean[]; lookup?: (ClaimRow | undefined)[]; tryTakeover?: boolean[]; maxAttempts?: number }) {
  const insertQ = [...(seq.tryInsert ?? [])];
  const lookupQ = [...(seq.lookup ?? [])];
  const takeoverQ = [...(seq.tryTakeover ?? [])];
  const tryInsert = vi.fn(async () => {
    if (insertQ.length === 0) throw new Error("tryInsert called more times than the test expected");
    return insertQ.shift()!;
  });
  const lookup = vi.fn(async () => {
    if (lookupQ.length === 0) throw new Error("lookup called more times than the test expected");
    return lookupQ.shift();
  });
  const tryTakeover = vi.fn(async () => {
    if (takeoverQ.length === 0) throw new Error("tryTakeover called more times than the test expected");
    return takeoverQ.shift()!;
  });
  return { tryInsert, lookup, tryTakeover, requestHash: HASH, staleMs: STALE_MS, now: () => NOW, maxAttempts: seq.maxAttempts };
}

describe("resolveClaim", () => {
  it("[insert ok] proceeds without ever looking up", async () => {
    const o = ops({ tryInsert: [true] });
    await expect(resolveClaim(o)).resolves.toEqual({ kind: "proceed" });
    expect(o.tryInsert).toHaveBeenCalledTimes(1);
    expect(o.lookup).not.toHaveBeenCalled();
  });

  it("[conflict, lookup missing, insert ok] retries the insert rather than proceeding bare", async () => {
    const o = ops({ tryInsert: [false, true], lookup: [undefined] });
    await expect(resolveClaim(o)).resolves.toEqual({ kind: "proceed" });
    expect(o.tryInsert).toHaveBeenCalledTimes(2);
  });

  it("[conflict, lookup missing] x3 gives up as in_progress after maxAttempts, never proceeding bare", async () => {
    const o = ops({ tryInsert: [false, false, false], lookup: [undefined, undefined, undefined] });
    await expect(resolveClaim(o)).resolves.toEqual({ kind: "in_progress" });
    expect(o.tryInsert).toHaveBeenCalledTimes(3);
  });

  it("[conflict, lookup fresh same hash] reports in_progress", async () => {
    const o = ops({ tryInsert: [false], lookup: [row({ createdAt: new Date(NOW) })] });
    await expect(resolveClaim(o)).resolves.toEqual({ kind: "in_progress" });
  });

  it("[conflict, lookup different hash] reports conflict", async () => {
    const o = ops({ tryInsert: [false], lookup: [row({ requestHash: "hash-b" })] });
    await expect(resolveClaim(o)).resolves.toEqual({ kind: "conflict" });
  });

  it("[conflict, lookup completed] replays the stored status and body", async () => {
    const response = { ok: true, id: "abc" };
    const o = ops({ tryInsert: [false], lookup: [row({ statusCode: 201, response })] });
    await expect(resolveClaim(o)).resolves.toEqual({ kind: "replay", statusCode: 201, response });
  });

  it("[conflict, lookup stale, takeover ok] proceeds", async () => {
    const stale = row({ createdAt: new Date(NOW - STALE_MS - 1) });
    const o = ops({ tryInsert: [false], lookup: [stale], tryTakeover: [true] });
    await expect(resolveClaim(o)).resolves.toEqual({ kind: "proceed" });
    expect(o.tryTakeover).toHaveBeenCalledTimes(1);
  });

  it("[conflict, lookup stale, takeover fails, lookup completed] replays whatever is there once the race is lost", async () => {
    const response = { ok: true };
    const stale = row({ createdAt: new Date(NOW - STALE_MS - 1) });
    const o = ops({
      tryInsert: [false, false],
      lookup: [stale, row({ statusCode: 200, response })],
      tryTakeover: [false],
    });
    await expect(resolveClaim(o)).resolves.toEqual({ kind: "replay", statusCode: 200, response });
    expect(o.tryTakeover).toHaveBeenCalledTimes(1);
  });
});
