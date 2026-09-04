import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as FX from "@rch/contract/fixtures";
import { BillsResponseSchema, SnapshotSchema, StockResponseSchema, UserMinSchema } from "@rch/contract";
import * as s from "../../db/schema/index.js";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { resetDocuments, truncateAll, warmPool } from "../../test/db.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "snapshot" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });
// The cases below raise documents of their own, so the document half is put back between them.
// The master half is seeded once, above — with the one exception noted on the roster case, which
// is the only case here that writes a master table.
beforeEach(async () => { await resetDocuments(app.testDb!.db); });
const getAs = async (userId: string, url: string) => { const r = await app.inject({ method: "GET", url, headers: await authHeaders(app, userId) }); expect(r.statusCode, r.body).toBe(200); return r.json(); };
const get = (userId: string) => getAs(userId, "/api/v1/snapshot");

describe("GET /snapshot", () => {
  it("validates against the contract and carries the caller", async () => {
    const s = await get("u2");
    expect(SnapshotSchema.safeParse(s).success).toBe(true);
    expect(s.user.id).toBe("u2");
  });
  it("master data equals the fixtures", async () => {
    const s = await get("u2");
    expect(s.items).toEqual(FX.IT);
    expect(s.locations).toEqual(FX.LOC);
    expect(s.recipes).toEqual(FX.RCP);
    expect(s.prices).toEqual(FX.PL);
    expect(s.menu).toEqual(FX.MENU);
    expect(s.users.map((u: { id: string }) => u.id).sort()).toEqual(FX.USERS.map((u) => u.id).sort());
  });
  it("stock, reservations and overrides come from the ledger", async () => {
    const s = await get("u3");
    for (const [loc, byItem] of Object.entries(FX.seedStock)) for (const [it, q] of Object.entries(byItem)) expect(s.stock[loc][it], `${loc}/${it}`).toBe(q);
    expect(s.rsv).toEqual(FX.seedRsv());
    expect(s.ovr).toEqual({});
  });
  it("a counter operator sees only their own location", async () => {
    const s = await get("u1"); // Kavitha, coffee
    expect(Object.keys(s.stock)).toEqual(["coffee"]);
    expect(Object.keys(s.menu)).toEqual(["coffee"]);
    expect(s.req.every((r: { from: string }) => r.from === "coffee")).toBe(true);
    expect(s.tkt.every((t: { from: string; to: string }) => t.from === "coffee" || t.to === "coffee")).toBe(true);
    expect(s.bills.every((b: { loc: string }) => b.loc === "coffee")).toBe(true);
    // master data is never scoped: prices for both lists, every item, every location
    expect(Object.keys(s.items).length).toBe(Object.keys(FX.IT).length);
    // revenue is not master data: the counter gets its own column and nobody else's
    const full = await get("u2");
    expect(s.dayLabels).toEqual(full.dayLabels);
    expect(s.sales.length).toBe(full.sales.length);
    expect(s.sales.every((row: number[]) => row.length === 1)).toBe(true);
    expect(s.sales.map((row: number[]) => row[0])).toEqual(full.sales.map((row: number[]) => row[1])); // coffee is column 1
    expect(full.sales.some((row: number[]) => row.length > 1)).toBe(true);
  });
  it("is fast enough on the seed", async () => {
    const h = await authHeaders(app, "u2");
    // Warm up once, then take the best of five. This pins the query shape (an N+1 over users
    // once cost eight round trips), not the p95 SLO of spec §12 — that is measured by the
    // Phase 6 load check on a quiet box. 500 ms is loose enough for five suites sharing one
    // Postgres and still an order of magnitude under a regression.
    await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: h });
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: h });
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(500);
  });
});

describe("the colleague directory is a name badge, not a contact list", () => {
  it("carries only what a screen renders — no email, employee number or phone", async () => {
    const s = await get("u2");
    expect(s.users.length).toBeGreaterThan(1);
    for (const u of s.users) {
      expect(UserMinSchema.safeParse(u).success, JSON.stringify(u)).toBe(true);
      expect(Object.keys(u).sort()).toEqual(["col", "id", "loc", "n", "r", "rl"]);
    }
  });
  it("still hands the caller their own record whole — Settings prints the employee number", async () => {
    const s = await get("u2");
    expect(s.user.emp).toBeTruthy();
    expect(s.user.e).toBeTruthy();
    expect(s.user.ph).toBeTruthy();
  });
});

describe("GET /stock", () => {
  it("answers with the three maps the snapshot carries, and nothing else", async () => {
    const [s, st] = await Promise.all([get("u3"), getAs("u3", "/api/v1/stock")]);
    expect(StockResponseSchema.safeParse(st).success).toBe(true);
    expect(st).toEqual({ stock: s.stock, rsv: s.rsv, ovr: s.ovr });
  });
  it("is scoped to a counter operator's own counter, exactly as the snapshot is", async () => {
    const [s, st] = await Promise.all([get("u1"), getAs("u1", "/api/v1/stock")]);
    expect(Object.keys(st.stock)).toEqual(["coffee"]);
    expect(Object.keys(st.rsv).every((k: string) => k.startsWith("coffee:"))).toBe(true);
    expect(st).toEqual({ stock: s.stock, rsv: s.rsv, ovr: s.ovr });
  });
});

describe("GET /bills", () => {
  it("defaults to the same week the snapshot shows", async () => {
    const [s, bills] = await Promise.all([get("u3"), getAs("u3", "/api/v1/bills")]);
    expect(BillsResponseSchema.safeParse(bills).success).toBe(true);
    expect(bills).toEqual(s.bills);
  });
  it("takes a wider window on ?days=", async () => {
    const wide = await getAs("u3", "/api/v1/bills?days=90");
    const week = await getAs("u3", "/api/v1/bills");
    expect(wide.length).toBeGreaterThanOrEqual(week.length);
  });
  it("refuses a window outside the contract rather than guessing", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/bills?days=0", headers: await authHeaders(app, "u3") });
    expect(r.statusCode).toBe(400);
  });
  it("is scoped to a counter operator's own counter", async () => {
    const bills = await getAs("u1", "/api/v1/bills?days=90");
    expect(bills.length).toBeGreaterThan(0);
    expect(bills.every((b: { loc: string }) => b.loc === "coffee")).toBe(true);
  });
});

describe("the document reads the movement chain refetches", () => {
  it("GET /requests gives a manager every request and a counter only their own outlet's", async () => {
    const all = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") });
    expect(all.statusCode).toBe(200);
    expect(all.json().map((r: { id: string }) => r.id)).toEqual(["REQ-2026-0909", "REQ-2026-0910", "REQ-2026-0911", "REQ-2026-0912"]);

    const mine = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u1") });
    expect(mine.json().map((r: { id: string }) => r.id)).toEqual(["REQ-2026-0909", "REQ-2026-0911"]);   // u1 is at coffee
  });

  it("GET /tickets gives a counter the tickets that touch their counter, either end", async () => {
    const mine = await app.inject({ method: "GET", url: "/api/v1/tickets", headers: await authHeaders(app, "u1") });
    expect(mine.statusCode).toBe(200);
    // u1 is at coffee, which is where this ticket is going, and it is still Issued — the one
    // caller who reads the six digits. The trail is the seeded one, replayed from the fixture.
    expect(mine.json()).toEqual([{
      id: "TKT-0440", req: "REQ-2026-0909", from: "store", to: "coffee", lines: [{ it: "cup", qty: 500 }],
      st: "Issued", otp: "418327", hist: [{ s: "Issued", who: "Suresh Muthu", t: expect.any(String) }],
    }]);

    const other = await app.inject({ method: "GET", url: "/api/v1/tickets", headers: await authHeaders(app, "u6") });
    expect(other.json()).toEqual([]);      // u6 is at kiosk; TKT-0440 goes to coffee
  });

  it("GET /shop-asks gives a counter the asks at either end and a manager all of them", async () => {
    const mgr = await app.inject({ method: "GET", url: "/api/v1/shop-asks", headers: await authHeaders(app, "u2") });
    expect(mgr.json().map((a: { id: string }) => a.id).sort()).toEqual(["ASK-0059", "ASK-0060"]);
    const kiosk = await app.inject({ method: "GET", url: "/api/v1/shop-asks", headers: await authHeaders(app, "u6") });
    expect(kiosk.json().map((a: { id: string }) => a.id).sort()).toEqual(["ASK-0059", "ASK-0060"]);   // kiosk is one end of both
  });

  it("answers each read with exactly the slice the snapshot carries", async () => {
    const snap = (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u1") })).json();
    for (const [url, key] of [["/api/v1/requests", "req"], ["/api/v1/tickets", "tkt"], ["/api/v1/shop-asks", "shopAsks"]] as const) {
      const r = await app.inject({ method: "GET", url, headers: await authHeaders(app, "u1") });
      expect(r.json()).toEqual(snap[key]);
    }
  });
});

describe("GET /prod-orders and GET /batches", () => {
  it("hand the kitchen its whole board and its whole batch log", async () => {
    const snap = (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u4") })).json();

    const orders = await app.inject({ method: "GET", url: "/api/v1/prod-orders", headers: await authHeaders(app, "u4") });
    expect(orders.statusCode, orders.body).toBe(200);
    expect(orders.json().map((o: { id: string }) => o.id)).toEqual(snap.pord.map((o: { id: string }) => o.id));

    const batches = await app.inject({ method: "GET", url: "/api/v1/batches", headers: await authHeaders(app, "u4") });
    expect(batches.statusCode, batches.body).toBe(200);
    expect(batches.json().map((b: { id: string }) => b.id)).toEqual(snap.batch.map((b: { id: string }) => b.id));
    expect(batches.json()[0]).toMatchObject({ it: expect.any(String), qty: expect.any(Number), made: expect.any(Number) });
  });

  it("cut a counter down the same way the snapshot does", async () => {
    // u1 is the Coffee Shop. The seeded orders were raised by the Snack Kiosk, so the coffee
    // counter sees none of them — and no counter sees the kitchen's batch log at all.
    const snap = (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u1") })).json();
    const orders = (await app.inject({ method: "GET", url: "/api/v1/prod-orders", headers: await authHeaders(app, "u1") })).json();
    const batches = (await app.inject({ method: "GET", url: "/api/v1/batches", headers: await authHeaders(app, "u1") })).json();

    expect(orders.map((o: { id: string }) => o.id)).toEqual(snap.pord.map((o: { id: string }) => o.id));
    // Spelled out rather than left to `orders.every(...)`, which is true of an empty array and
    // would have gone on passing if the route stopped scoping by outlet altogether. The
    // positive — a counter seeing its own orders and nobody else's — is the u6 case below.
    expect(orders).toEqual([]);
    expect(batches).toEqual([]);
    expect(snap.batch).toEqual([]);
  });

  it("shows a counter the orders their own outlet raised", async () => {
    // u6 is the Snack Kiosk, which raised both seeded orders.
    const orders = (await app.inject({ method: "GET", url: "/api/v1/prod-orders", headers: await authHeaders(app, "u6") })).json();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o: { from: string }) => o.from === "kiosk")).toBe(true);
  });
});

describe("the six buying reads", () => {
  const READS = [
    ["requisitions", "prq"], ["purchase-orders", "po"], ["grns", "grn"],
    ["vendors", "vendors"], ["contracts", "contracts"], ["product-requests", "productReqs"],
  ] as const;

  it("hand the buyer exactly what the buyer's snapshot carries", async () => {
    const snap = await getAs("u5", "/api/v1/snapshot");
    for (const [path, slice] of READS) {
      const rows = await getAs("u5", `/api/v1/${path}`);
      expect(rows.map((r: { id: string }) => r.id), path).toEqual(snap[slice].map((r: { id: string }) => r.id));
      expect(rows.length, path).toBeGreaterThan(0);
    }
  });

  it("give a counter operator nothing of buying but the requests their own shop raised", async () => {
    // u1 is the Coffee Shop. The seeded product request was raised for the Coffee Shop, so it
    // is the one buying collection a counter sees anything in.
    for (const [path] of READS.filter(([, s]) => s !== "productReqs")) {
      expect(await getAs("u1", `/api/v1/${path}`), path).toEqual([]);
    }
    const mine = await getAs("u1", "/api/v1/product-requests");
    expect(mine.every((p: { forLoc: string }) => p.forLoc === "coffee")).toBe(true);
    expect(await getAs("u6", "/api/v1/product-requests")).toEqual([]);   // u6 is the Snack Kiosk
  });
});

describe("quarantine", () => {
  it("is a location the store keeper can see, with a shelf of its own", async () => {
    const snap = await getAs("u3", "/api/v1/snapshot");
    expect(snap.locations.quarantine).toMatchObject({ n: "Quarantine", type: "Store" });
    // Empty on the seed — nothing has been rejected — but present, so a screen can read it.
    expect(snap.stock.quarantine).toEqual({});
    expect((await getAs("u3", "/api/v1/stock")).stock.quarantine).toEqual({});
  });

  it("is nowhere in a counter operator's world", async () => {
    const snap = await getAs("u1", "/api/v1/snapshot");
    expect(Object.keys(snap.stock)).toEqual(["coffee"]);
    // Locations are master data and are never cut down — the counter sees the name, and has no
    // route that would let them name it.
    expect(snap.locations.quarantine).toBeDefined();
  });
});

type WireTicket = { id: string; st: string; otp: string; hist: { s: string; t: string }[] };
const ticketIn = (snap: { tkt: WireTicket[] }, id: string): WireTicket => snap.tkt.find((x) => x.id === id)!;

describe("what a ticket carries, and to whom", () => {
  it("gives a ticket its own trail, oldest first", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 4 }] });
    const snap = await get("u3");                                 // the store keeper
    const t = ticketIn(snap, id);
    expect(t.hist.length).toBeGreaterThan(0);
    expect(t.hist.map((h) => h.s)).toContain("Issued");
    // Times are ISO on the wire, like every other document's history.
    expect(t.hist[0]!.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("shows the six digits to the shop that is collecting and to nobody else", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 4 }] });

    const collector = ticketIn(await get("u1"), id);              // counter at coffee, the ticket's `to`
    expect(collector.otp).toMatch(/^\d{6}$/);

    expect(ticketIn(await get("u3"), id).otp).toBe("");           // the store keeper, who issued it
    expect(ticketIn(await get("u2"), id).otp).toBe("");           // the manager, who sees everything else
  });

  it("withholds them from a role that never collects, even standing at the ticket's own `to`", async () => {
    // The outlet manager's home location is an outlet — `rest` in the fixtures — so a check on
    // location alone handed them the digits for every Issued Restaurant-bound ticket in their
    // snapshot. They are not the collecting end of anything; a counter at the same location is.
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "rest", lines: [{ it: "milk", qty: 4 }] });
    expect(ticketIn(await get("u2"), id).otp).toBe("");           // the manager, at `rest`
    // The buyer sits at the central store, so the same test with the other role that never
    // collects: a store-bound ticket's digits are not theirs either.
    const inbound = await given.ticket(app.testDb!.db, { from: "kitchen", to: "store", lines: [{ it: "puff", qty: 2 }] });
    expect(ticketIn(await get("u5"), inbound).otp).toBe("");       // the buyer, at `store`
    expect(ticketIn(await get("u3"), inbound).otp).toMatch(/^\d{6}$/); // the store keeper, who does collect
  });

  it("takes the digits back once the ticket has been collected", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 4 }], st: "Collected" });
    expect(ticketIn(await get("u1"), id).otp).toBe("");
  });

  it("keeps them out of the answer the issuing desk gets back, and only there", async () => {
    // Every path that mints a ticket answers the location it leaves from — the store issuing
    // against an approved request, the shop granting an ask, the kitchen dispatching — so the
    // write response is the one place the digits could still have travelled to `from`.
    const req = await given.request(app.testDb!.db, { from: "coffee", lines: [{ it: "milk", qty: 4, appr: 4 }], st: "Manager approved" });
    const issued = await app.inject({
      method: "POST", url: `/api/v1/requests/${req}/issue-ticket`,
      headers: { ...(await authHeaders(app, "u3")), "idempotency-key": randomUUID() },
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const tkt = issued.json().result.ticket;
    expect(tkt.st).toBe("Issued");
    expect(tkt.otp).toBe("");
    // And the shop that will collect reads them, off its own snapshot, where they belong.
    expect(ticketIn(await get("u1"), tkt.id).otp).toMatch(/^\d{6}$/);
  });

  it("withholds them from GET /tickets too, so a refetch does not put them back", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 4 }] });
    const list = async (u: string) => (await getAs(u, "/api/v1/tickets")) as WireTicket[];
    expect((await list("u3")).find((t) => t.id === id)!.otp).toBe("");
    expect((await list("u1")).find((t) => t.id === id)!.otp).toMatch(/^\d{6}$/);
  });

  it("hands a counter the roster it bills against, from the payers table", async () => {
    // The only case in this file that writes a master table, so it puts the whole seed back
    // first: `resetDocuments` restores the document half and leaves `payers` where it found it.
    await truncateAll(app.testDb!.db);
    await seedTestDb(app.testDb!.db);
    const snap = await get("u1");
    expect(snap.roster.patients.length).toBeGreaterThan(0);
    expect(snap.roster.staff.length).toBeGreaterThan(0);
    expect(snap.roster.depts.length).toBeGreaterThan(0);
    expect(snap.roster.staff.every((p: { kind: string }) => p.kind === "staff")).toBe(true);
    // A payer switched off is not offered at the till.
    const off = and(eq(s.payers.kind, "staff"), eq(s.payers.id, snap.roster.staff[0].id));
    await app.testDb!.db.update(s.payers).set({ active: false }).where(off);
    expect((await get("u1")).roster.staff.length).toBe(snap.roster.staff.length - 1);
    // Put them back on: `beforeEach` runs `resetDocuments`, which never touches `payers`, so a
    // case that leaves one deactivated leaves it deactivated for every case after it in the file.
    await app.testDb!.db.update(s.payers).set({ active: true }).where(off);
    expect((await get("u1")).roster.staff.length).toBe(snap.roster.staff.length);
  });

  it("shows every role its own support tickets and nobody else's", async () => {
    const mine = await given.supportTicket(app.testDb!.db, { by: "u4", subject: "Kitchen board is blank" });
    const theirs = await given.supportTicket(app.testDb!.db, { by: "u5", subject: "Vendor list will not load" });
    const ids = (await get("u4")).tickets.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining([mine]));
    expect(ids).not.toContain(theirs);
    // And the other way round, so the case is about ownership rather than about who asked.
    const others = (await get("u5")).tickets.map((t: { id: string }) => t.id);
    expect(others).toEqual(expect.arrayContaining([theirs]));
    expect(others).not.toContain(mine);
  });
});

describe("one request, one connection", () => {
  // `pg` checks a client out of the pool per query and emits `acquire` each time, so counting
  // that event over one injected request counts exactly what the pool was asked for. Before the
  // readers were folded into a single read-only transaction, `GET /snapshot` fanned out with
  // `Promise.all` and this counted about forty against a pool of ten — which is the whole of
  // RUNBOOK §12's c=30 finding (`pg_pool_idle` 0, `pg_pool_waiting` peaking at 771, p95 2.9 s).
  // A number greater than one here is that defect coming back, whatever the latency looks like.
  const acquiresDuring = async (url: string, userId: string): Promise<number> => {
    const headers = await authHeaders(app, userId);              // minted before the count starts
    const pool = app.testDb!.pool;
    let n = 0;
    const tick = () => { n += 1; };
    pool.on("acquire", tick);
    try {
      const r = await app.inject({ method: "GET", url, headers });
      expect(r.statusCode, r.body).toBe(200);
    } finally {
      pool.off("acquire", tick);
    }
    return n;
  };

  it("reads the whole snapshot on a single pooled connection", async () => {
    expect(await acquiresDuring("/api/v1/snapshot", "u2")).toBe(1);
  });

  it("does the same for every standalone read that fans out", async () => {
    // Each of these used to be its own `Promise.all`: /stock is three readers, /tickets three
    // queries, /bills two plus a follow-up, /requisitions four. `/recipes` belongs to the
    // `master` module rather than this one and reads heads and lines separately — it is the last
    // multi-query read in the API that was still taking two connections, so it is pinned here
    // beside the rest rather than left as the exception to the guide's own sentence.
    expect(await acquiresDuring("/api/v1/stock", "u3")).toBe(1);
    expect(await acquiresDuring("/api/v1/tickets", "u3")).toBe(1);
    expect(await acquiresDuring("/api/v1/bills?days=7", "u2")).toBe(1);
    expect(await acquiresDuring("/api/v1/requisitions", "u5")).toBe(1);
    expect(await acquiresDuring("/api/v1/recipes", "u2")).toBe(1);
  });

  it("still asks for one connection each when three snapshots run at once", async () => {
    // The concurrent form of the same fact, which is the one the load check actually exercised:
    // three requests in flight must want three connections, not three times forty. The pool is
    // warmed first so the count is about what the readers ask for rather than about how lazily
    // `pg` opens sockets (`warmPool`, test/db.ts).
    //
    // `pg_pool_waiting` is deliberately not what this asserts. `pg-pool` queues a caller before
    // it looks for an idle client, so the gauge reads 1 for a moment even when every caller is
    // served on the same tick — a real reading for an alert, too noisy for a zero-or-not
    // assertion. The acquisition count is exact.
    await warmPool(app.testDb!, 3);
    const headers = await authHeaders(app, "u2");
    const pool = app.testDb!.pool;
    let n = 0;
    const tick = () => { n += 1; };
    pool.on("acquire", tick);
    try {
      const rs = await Promise.all([1, 2, 3].map(() => app.inject({ method: "GET", url: "/api/v1/snapshot", headers })));
      for (const r of rs) expect(r.statusCode, r.body).toBe(200);
    } finally {
      pool.off("acquire", tick);
    }
    expect(n).toBe(3);
  });
});
