import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import type { AuditEvent } from "@rch/contract";
import type { App } from "../app.js";
import { maskSecrets } from "../lib/audit.js";
import { buildTestApp } from "../test/app.js";
import { authHeaders } from "../test/auth.js";
import { given } from "../test/builders.js";
import { seedTestDb } from "../test/seed.js";

/**
 * Every write that edits or removes an existing master row or account names what it replaced
 * (`auditBefore`, spec §2.4), so the audit drawer can show before → after. One case per service.
 *
 * Where it can, a case makes the same edit twice: the second edit's `before` must equal the first
 * edit's `result`. That is the property the drawer's diff relies on - a before value is the same
 * wire shape as the answer, field for field. Both sides go through `maskSecrets`, because the
 * outbox stores both masked.
 */
let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "audit_before" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

type Body = { result: Record<string, unknown> } & Record<string, unknown>;
const send = async (user: string, method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>): Promise<Body> => {
  const opts: InjectOptions = { method, url: `/api/v1${url}`, headers: { ...(await authHeaders(app, user)), "idempotency-key": randomUUID() } };
  if (payload !== undefined) opts.payload = payload;
  const r = await app.inject(opts);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Body;
};
const read = async (url: string) => {
  const r = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, "u2") });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
/** The newest outbox event for one route, read straight off the table - a test may; nothing
 *  under src/ may (scripts/check-boundaries.sh). */
const lastEvent = async (action: string): Promise<AuditEvent> => {
  const r = await app.testDb!.pool.query<{ event: AuditEvent }>(
    "select event from audit_outbox where event->>'action' = $1 order by id desc limit 1", [action]);
  expect(r.rows, `no ${action} event in the outbox`).toHaveLength(1);
  return r.rows[0]!.event;
};

describe("before values: prices, menus, the availability switch and the item master", () => {
  it("savePrice keeps the list's old price, and null where that list never priced the item", async () => {
    expect((await read("/prices"))["PL-001"].juice).toBe(18);
    const first = await send("u2", "PUT", "/prices/PL-001/juice", { price: 19 });
    expect((await lastEvent("savePrice")).before).toEqual({ list: "PL-001", it: "juice", price: 18 });
    await send("u2", "PUT", "/prices/PL-001/juice", { price: 17 });
    expect((await lastEvent("savePrice")).before).toEqual(maskSecrets(first.result));
    await send("u2", "PUT", "/prices/PL-001/box", { price: 3 });
    expect((await lastEvent("savePrice")).before).toEqual({ list: "PL-001", it: "box", price: null });
  });

  it("addMenuItem and removeMenuItem keep the outlet's listing as it stood", async () => {
    const listing = (await read("/menus")).coffee as string[];
    const added = await send("u2", "POST", "/menus/coffee/items", { it: "sand" });
    expect((await lastEvent("addMenuItem")).before).toEqual({ loc: "coffee", items: listing });
    await send("u2", "DELETE", "/menus/coffee/items/sand");
    expect((await lastEvent("removeMenuItem")).before).toEqual(maskSecrets(added.result));
  });

  it("toggleAvail keeps whether the item was on or off at that counter", async () => {
    const first = await send("u1", "POST", "/availability/toggle", { loc: "coffee", it: "juice" });
    expect((await lastEvent("toggleAvail")).before).toMatchObject({ loc: "coffee", it: "juice", off: !first.result.off });
    await send("u1", "POST", "/availability/toggle", { loc: "coffee", it: "juice" });
    expect((await lastEvent("toggleAvail")).before).toEqual(maskSecrets(first.result));
  });

  it("patchItem keeps the line as it was, in the { key, item } shape it answers with", async () => {
    const was = (await read("/items")).bisc;
    const first = await send("u3", "PATCH", "/items/bisc", { rl: 35 });
    expect((await lastEvent("patchItem")).before).toEqual({ key: "bisc", item: was });
    await send("u3", "PATCH", "/items/bisc", { rl: 40 });
    expect((await lastEvent("patchItem")).before).toEqual(maskSecrets(first.result));
  });

  it("setItemImage and removeItemImage keep the line as it was, in the { key, item } shape they answer with", async () => {
    const was = (await read("/items")).chai;
    const bytes = new Uint8Array(64).fill(1);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    const data = Buffer.from(bytes).toString("base64");
    const first = await send("u2", "PUT", "/items/chai/image", { data });
    expect((await lastEvent("setItemImage")).before).toEqual({ key: "chai", item: was });
    await send("u2", "DELETE", "/items/chai/image");
    expect((await lastEvent("removeItemImage")).before).toEqual(maskSecrets(first.result));
  });
});

describe("before values: price lists", () => {
  it("deletePriceList keeps the list as it stood, unattached", async () => {
    const created = await send("u2", "POST", "/price-lists", { name: "Audit Probe List", cloneFrom: "rest" });
    await send("u2", "DELETE", `/price-lists/${String(created.result.id)}`);
    expect((await lastEvent("deletePriceList")).before).toEqual(maskSecrets(created.result));
  });

  it("setOutletPriceList keeps the outlet's previous list", async () => {
    const created = await send("u2", "POST", "/price-lists", { name: "Audit Probe List 2", cloneFrom: "rest" });
    await send("u2", "PUT", "/outlets/rest/price-list", { listId: created.result.id as string });
    expect((await lastEvent("setOutletPriceList")).before).toEqual({ loc: "rest", listId: "PL-001" });
    // Switch it back, so the outlet is left exactly as this suite found it.
    await send("u2", "PUT", "/outlets/rest/price-list", { listId: "PL-001" });
    expect((await lastEvent("setOutletPriceList")).before).toEqual({ loc: "rest", listId: created.result.id });
  });
});

describe("before values: vendors, rate contracts and the caller's own account", () => {
  it("updateVendor keeps the vendor as it was", async () => {
    const first = await send("u5", "PATCH", "/vendors/VN-005", { contact: "Selvi Murugan" });
    expect((await lastEvent("updateVendor")).before).toMatchObject({ id: "VN-005", contact: "Selvi M" });
    await send("u5", "PATCH", "/vendors/VN-005", { contact: "Selvi M." });
    expect((await lastEvent("updateVendor")).before).toEqual(maskSecrets(first.result));
  });

  it("updateContract and removeContract keep the contract as it was", async () => {
    const first = await send("u3", "PATCH", "/contracts/RC-101", { moq: 45 });
    expect((await lastEvent("updateContract")).before).toMatchObject({ id: "RC-101", moq: 40, active: true });
    await send("u3", "PATCH", "/contracts/RC-101", { moq: 50 });
    expect((await lastEvent("updateContract")).before).toEqual(maskSecrets(first.result));

    const closed = await send("u3", "DELETE", "/contracts/RC-102");
    const ev = await lastEvent("removeContract");
    expect(ev.before).toMatchObject({ id: "RC-102", active: true });
    // A close changes one field; everything else the drawer shows is the same on both sides.
    expect({ ...(ev.before as Record<string, unknown>), active: false }).toEqual(maskSecrets(closed.result));
  });

  it("patchMe keeps the caller's own record as it was", async () => {
    const first = await send("u3", "PATCH", "/me", { ph: "90000 00001" });
    expect((await lastEvent("patchMe")).before).toMatchObject({ user: { id: "u3", ph: "94430 51194" } });
    await send("u3", "PATCH", "/me", { ph: "90000 00002" });
    // `/me` answers without a `result` envelope, so its before is the whole answer's shape - the
    // same value `writeOutcomeOf` (lib/audit.ts) stores whole as its `result`.
    expect((await lastEvent("patchMe")).before).toEqual(maskSecrets(first));
  });
});

describe("before values: a draft purchase order", () => {
  /** A fresh draft on VN-001: one milk line of 60, claimed off an approved requisition - the
   *  purchase-order suite's own set-up. Its create answer is the order as the edit will find it. */
  const draft = async (): Promise<Record<string, unknown>> => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    return (await send("u5", "POST", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] })).result;
  };

  it("updatePoLine keeps the order as it stood", async () => {
    const po = await draft();
    await send("u5", "PATCH", `/purchase-orders/${String(po.id)}/lines/0`, { rate: 50 });
    expect((await lastEvent("updatePoLine")).before).toEqual(maskSecrets(po));
  });

  it("removePoLine keeps the order as it stood", async () => {
    const po = await draft();
    await send("u5", "DELETE", `/purchase-orders/${String(po.id)}/lines/0`);
    expect((await lastEvent("removePoLine")).before).toEqual(maskSecrets(po));
  });

  it("patchPo keeps the order as it stood", async () => {
    const po = await draft();
    await send("u5", "PATCH", `/purchase-orders/${String(po.id)}`, { eta: "2026-10-15" });
    expect((await lastEvent("patchPo")).before).toEqual(maskSecrets(po));
  });
});

describe("before values: staff accounts", () => {
  /** A fresh counter account at the Snack Kiosk, made by the seeded super admin (u7), so no case
   *  moves a colleague another case relies on. Its create answer, less the one-time password, is
   *  the account as the next edit will find it. */
  const account = async (): Promise<Record<string, unknown>> => {
    const tag = randomUUID().slice(0, 8);
    const r = await send("u7", "POST", "/admin/users", { name: `Audit Probe ${tag}`, email: `probe-${tag}@royalcare.in`, role: "counter", loc: "kiosk" });
    return Object.fromEntries(Object.entries(r.result).filter(([k]) => k !== "tempPassword"));
  };

  it("updateAdminUser keeps the account as it was", async () => {
    const u = await account();
    await send("u7", "PATCH", `/admin/users/${String(u.id)}`, { role: "counter", loc: "coffee" });
    expect((await lastEvent("updateAdminUser")).before).toEqual(maskSecrets(u));
  });

  it("deactivateAdminUser and reactivateAdminUser each keep the account as it was", async () => {
    const u = await account();
    const off = await send("u7", "POST", `/admin/users/${String(u.id)}/deactivate`);
    expect((await lastEvent("deactivateAdminUser")).before).toEqual(maskSecrets(u));
    await send("u7", "POST", `/admin/users/${String(u.id)}/reactivate`);
    expect((await lastEvent("reactivateAdminUser")).before).toEqual(maskSecrets(off.result));
  });

  it("resetAdminUserPassword keeps the account as it was", async () => {
    const u = await account();
    await send("u7", "POST", `/admin/users/${String(u.id)}/reset-password`);
    expect((await lastEvent("resetAdminUserPassword")).before).toEqual(maskSecrets(u));
  });

  it("deleteAdminUser keeps the account it removed", async () => {
    const u = await account();
    const off = await send("u7", "POST", `/admin/users/${String(u.id)}/deactivate`);
    await send("u7", "DELETE", `/admin/users/${String(u.id)}`);
    expect((await lastEvent("deleteAdminUser")).before).toEqual(maskSecrets(off.result));
  });
});
