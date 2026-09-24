import { describe, expect, it } from "vitest";
import { createAccessCache, type RoleAccess } from "./access.js";

const counter: RoleAccess = { roleId: "ROLE-001", desk: "counter", perms: { f: { billing: "edit" }, a: [] }, active: true };
const manager: RoleAccess = { roleId: "ROLE-002", desk: "manager", perms: { f: { prices: "edit" }, a: ["all_outlets"] }, active: true };

/** A loader whose answer the test sets, counting how often it is asked. */
function loader(initial: RoleAccess | null) {
  let answer = initial;
  const calls: string[] = [];
  return {
    calls,
    set: (a: RoleAccess | null) => { answer = a; },
    load: async (id: string) => { calls.push(id); return answer; },
  };
}

describe("the permission cache", () => {
  it("reads once, then answers from memory until the TTL runs out", async () => {
    let now = 1_000;
    const l = loader(counter);
    const cache = createAccessCache(l.load, { ttlMs: 60_000, now: () => now });
    expect(await cache.of("u1")).toEqual(counter);
    expect(await cache.of("u1")).toEqual(counter);
    expect(l.calls).toEqual(["u1"]);
    now += 59_999;
    await cache.of("u1");
    expect(l.calls).toHaveLength(1);
    now += 1;
    l.set(manager);
    expect(await cache.of("u1")).toEqual(manager);
    expect(l.calls).toHaveLength(2);
  });

  it("keys by account: a second account is a miss of its own", async () => {
    const l = loader(counter);
    const cache = createAccessCache(l.load);
    await cache.of("u1");
    await cache.of("u2");
    await cache.of("u1");
    expect(l.calls).toEqual(["u1", "u2"]);
  });

  it("caches an account with no role too, so a stale token cannot turn every request into a read", async () => {
    const l = loader(null);
    const cache = createAccessCache(l.load);
    expect(await cache.of("gone")).toBeNull();
    expect(await cache.of("gone")).toBeNull();
    expect(l.calls).toHaveLength(1);
  });

  it("clear() makes the next request read again", async () => {
    const l = loader(counter);
    const cache = createAccessCache(l.load);
    await cache.of("u1");
    l.set(manager);
    cache.clear();
    expect(await cache.of("u1")).toEqual(manager);
    expect(l.calls).toHaveLength(2);
  });

  it("a read in flight across a clear answers its own request but is not kept", async () => {
    let release!: (a: RoleAccess) => void;
    const calls: string[] = [];
    let slow = true;
    const cache = createAccessCache(async (id) => {
      calls.push(id);
      if (!slow) return manager;
      return new Promise<RoleAccess>((r) => { release = r; });
    });
    const inFlight = cache.of("u1");
    // The role changes while that read is on the wire, and the notice clears the cache.
    cache.clear();
    slow = false;
    release(counter);
    // The request that raced the change gets the answer it read...
    expect(await inFlight).toEqual(counter);
    // ...but the next one reads again, rather than trusting what was read before the clear.
    expect(await cache.of("u1")).toEqual(manager);
    expect(calls).toEqual(["u1", "u1"]);
  });
});
