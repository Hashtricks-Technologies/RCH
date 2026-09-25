import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { truncateAll } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { adminActions, locations, stockBalances, users } from "../../db/schema/index.js";

/** u7 (RC-0001) is the seeded super admin; u2 is the outlet manager, u1 a counter at the Coffee Shop. */
let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "admin_outlets" }); await app.ready(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });
afterAll(async () => { await app.close(); });

const as = async (id: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...(await authHeaders(app, id)), ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) }, payload });
const admin = (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) => as("u7", method, url, payload);
const JUICE = { name: "Juice Bar", code: "ot-jb", floor: "Ground", cc: "CC-JB" };
const open = async (body: Record<string, unknown> = JUICE) => {
  const r = await admin("POST", "/admin/outlets", body);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().result as { key: string; n: string };
};

describe("GET /admin/locations", () => {
  it("lists the store, the kitchen and every outlet by name, with who is based at each, and never quarantine", async () => {
    const r = await admin("GET", "/admin/locations");
    expect(r.statusCode, r.body).toBe(200);
    const rows = r.json() as { key: string; staff: number; active: boolean }[];
    expect(rows.map((l) => l.key)).toEqual(["kitchen", "store", "coffee", "rest", "kiosk"]);
    // The super admin's own placeholder location is not a posting: it is not counted.
    expect(Object.fromEntries(rows.map((l) => [l.key, l.staff]))).toEqual({ kitchen: 1, store: 2, coffee: 1, rest: 1, kiosk: 1 });
    expect(rows.every((l) => l.active)).toBe(true);
  });
  it("is a 404 to anyone without the flag", async () => {
    expect((await as("u2", "GET", "/admin/locations")).statusCode).toBe(404);
  });
});

describe("POST /admin/outlets", () => {
  it("opens an outlet with a key from its name, an upper-cased code and the default par factor, and logs it", async () => {
    const r = await admin("POST", "/admin/outlets", JUICE);
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j.result).toEqual({ key: "juice-bar", n: "Juice Bar", c: "OT-JB", type: "Outlet", floor: "Ground", cc: "CC-JB", active: true, staff: 0 });
    expect(j.changed).toEqual(["outlets", "locations"]);
    expect(j.message).toBe("Opened Juice Bar (OT-JB).");
    const [row] = await app.db.select().from(locations).where(eq(locations.key, "juice-bar"));
    expect(row).toMatchObject({ parFactor: 0.18, sellable: true, active: true });
    const feed = (await admin("GET", "/admin/actions?kind=outlets")).json() as { action: string; target: string; details: Record<string, unknown> }[];
    expect(feed[0]).toMatchObject({ action: "outlet_create", target: "Juice Bar", details: { key: "juice-bar", code: "OT-JB" } });
    expect(((await admin("GET", "/admin/actions")).json() as { action: string }[]).some((a) => a.action.startsWith("outlet_"))).toBe(false);
  });
  it("refuses a name or a code another location already has, whatever the case", async () => {
    const byName = await admin("POST", "/admin/outlets", { ...JUICE, name: "restaurant" });
    expect(byName.statusCode).toBe(409);
    expect(byName.json().error.message).toBe("Refused - a location named restaurant already exists");
    const byCode = await admin("POST", "/admin/outlets", { ...JUICE, code: "ot-r1" });
    expect(byCode.statusCode).toBe(409);
    expect(byCode.json().error.message).toBe("Refused - code OT-R1 is already in use");
  });
  it("steps past a key already taken", async () => {
    expect((await open({ ...JUICE, name: "Rest", code: "OT-RS" })).key).toBe("rest-2");
  });
  it("refuses a malformed body at the door", async () => {
    expect((await admin("POST", "/admin/outlets", { ...JUICE, name: "J" })).statusCode).toBe(400);
    expect((await admin("POST", "/admin/outlets", { ...JUICE, code: "OT JB" })).statusCode).toBe(400);
    expect((await admin("POST", "/admin/outlets", { ...JUICE, key: "juice" })).statusCode).toBe(400);
  });
});

describe("PATCH /admin/outlets/:key", () => {
  it("renames an outlet and moves its floor without touching its key, and logs what changed", async () => {
    await open();
    const r = await admin("PATCH", "/admin/outlets/juice-bar", { name: "Juice Hut", floor: "Floor 2" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result).toMatchObject({ key: "juice-bar", n: "Juice Hut", floor: "Floor 2" });
    expect(r.json().message).toBe("Saved Juice Hut.");
    const [line] = await app.db.select().from(adminActions).where(eq(adminActions.action, "outlet_update"));
    expect(line.details).toEqual({ key: "juice-bar", name: ["Juice Bar", "Juice Hut"], floor: ["Ground", "Floor 2"] });
  });
  it("refuses an edit that changes nothing", async () => {
    await open();
    const r = await admin("PATCH", "/admin/outlets/juice-bar", { name: "Juice Bar" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Nothing to save - Juice Bar already reads that way");
  });
  it("does not reach the store or the kitchen", async () => {
    const r = await admin("PATCH", "/admin/outlets/store", { name: "Main Store" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no outlet store.");
  });
});

describe("closing and reopening", () => {
  it("closes an outlet nothing depends on, keeps it listed, and reopens it", async () => {
    await open({ ...JUICE, name: "Tea Stall", code: "OT-TS" });
    const closed = await admin("POST", "/admin/outlets/tea-stall/close");
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().result.active).toBe(false);
    expect(closed.json().message).toBe("Closed Tea Stall. Its bills and reports are kept.");
    expect((await admin("POST", "/admin/outlets/tea-stall/close")).json().error.message).toBe("Tea Stall is already closed");
    const reopened = await admin("POST", "/admin/outlets/tea-stall/reopen");
    expect(reopened.json().result.active).toBe(true);
    expect(reopened.json().message).toBe("Reopened Tea Stall.");
    expect((await admin("POST", "/admin/outlets/tea-stall/reopen")).json().error.message).toBe("Tea Stall is already open");
  });
  it("refuses to close while anything still depends on the outlet, naming all of it at once", async () => {
    const { key } = await open();
    const hire = await admin("POST", "/admin/users", { name: "Arun P", email: "arun.p@royalcare.in", roleId: "ROLE-001", loc: key });
    expect(hire.statusCode, hire.body).toBe(200);
    const db = app.testDb!.db;
    // The outlet manager no longer adjusts a shelf directly (only a counter's own adjustment
    // request does, decided by the manager) - this test is about the close's own dependency
    // check, not about how stock gets onto a shelf, so the balance is seeded straight into the
    // ledger's own table rather than through either write path.
    await db.insert(stockBalances).values({ loc: key, itemKey: "juice", onHand: 4 });
    await given.ticket(db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: key, lines: [{ it: "chips", qty: 2 }] });
    await given.request(db, { from: key, lines: [{ it: "juice", qty: 5 }] });
    await given.prodOrder(db, { from: key });
    await given.shopAsk(db, { from: key, to: "coffee", it: "chips", qty: 1 });
    await given.productRequest(db, { name: "Mango lassi", forLoc: key });
    const r = await admin("POST", `/admin/outlets/${key}/close`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Refused - Juice Bar still has stock on hand (1 item), 1 open ticket, 1 open stock request, 1 open kitchen order, 1 open shop ask, 1 open product request and 1 active staff (${hire.json().result.emp})`);
    const [row] = await app.db.select().from(locations).where(eq(locations.key, key));
    expect(row.active).toBe(true);
  });
  it("puts no new staff at a closed outlet", async () => {
    const { key } = await open({ ...JUICE, name: "Tea Stall", code: "OT-TS" });
    await admin("POST", `/admin/outlets/${key}/close`);
    const r = await admin("POST", "/admin/users", { name: "Arun P", email: "arun.p@royalcare.in", roleId: "ROLE-001", loc: key });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("Counter Operator works at an open outlet - Tea Stall is closed");
  });
});

describe("an outlet opened after release", () => {
  it("sells end to end, and its takings reach the manager's snapshot and its own counter's alone", async () => {
    const { key } = await open();
    const hire = (await admin("POST", "/admin/users", { name: "Arun P", email: "arun.p@royalcare.in", roleId: "ROLE-001", loc: key })).json().result;
    await app.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, hire.id));
    // The outlet manager no longer adjusts a shelf directly - the counter raises the count and
    // the manager decides it, which is the one door onto this outlet's stock now.
    const adjReq = await as(hire.id, "POST", "/adjustment-requests", { reason: "count", lines: [{ it: "juice", qty: 5 }] });
    expect(adjReq.statusCode, adjReq.body).toBe(200);
    expect((await as("u2", "POST", `/adjustment-requests/${adjReq.json().result.id}/approve`)).statusCode).toBe(200);
    // The outlet opened on no price list at all (I1) - clone one from a counter that already
    // prices juice and attach it, the way the manager's own Settings drawer would, before the
    // till can list or sell anything.
    const unpriced = await as("u2", "POST", `/menus/${key}/items`, { it: "juice" });
    expect(unpriced.json().error.message).toBe("Refused - give Real Juice 200ml a price at Juice Bar before selling it there");
    const listId = (await as("u2", "POST", "/price-lists", { name: "Juice Bar prices", cloneFrom: "coffee" })).json().result.id;
    expect((await as("u2", "PUT", `/outlets/${key}/price-list`, { listId })).statusCode).toBe(200);
    expect((await as("u2", "POST", `/menus/${key}/items`, { it: "juice" })).statusCode).toBe(200);
    const sale = await as(hire.id, "POST", "/bills", { loc: key, tender: "Cash", lines: [{ it: "juice", qty: 2 }] });
    expect(sale.statusCode, sale.body).toBe(200);
    const manager = (await as("u2", "GET", "/snapshot")).json();
    expect(manager.locations[key]).toMatchObject({ n: "Juice Bar", type: "Outlet", active: true, par: 0.18 });
    expect(manager.menu[key]).toContain("juice");
    expect(manager.sales.at(-1)[key]).toBe(sale.json().result.tot);
    const counter = (await as(hire.id, "GET", "/snapshot")).json();
    expect(Object.keys(counter.stock)).toEqual([key]);
    expect(counter.sales.every((row: Record<string, number>) => Object.keys(row).join() === key)).toBe(true);
  });
});

describe("the events it announces", () => {
  it("tells every open browser that the location master changed", async () => {
    const { Client } = await import("pg");
    const { EVENTS_CHANNEL_PREFIX } = await import("../../lib/events.js");
    const base = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";
    const listener = new Client({ connectionString: base, options: `-c search_path=${app.testDb!.schemaName},public` });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (m) => { if (m.payload) heard.push(m.payload); });
    await listener.query(`listen "${EVENTS_CHANNEL_PREFIX}${app.testDb!.schemaName}"`);
    await open();
    await new Promise((r) => setTimeout(r, 150));
    await listener.end();
    expect(heard).toHaveLength(1);
    const notice = JSON.parse(heard[0]) as { collections: string[]; at: string };
    expect(notice.collections).toEqual(["outlets", "locations"]);
  });
});
