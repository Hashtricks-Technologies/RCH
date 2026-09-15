import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { createSigner } from "fast-jwt";
import { z } from "zod";
import {
  API_PREFIX, AUDIT_GROUP_KEYS, AUDIT_PATH, actionsInGroup, defineRoute, routes, serviceOf,
  type AuditActor, type AuditEntry, type AuditEvent, type AuditPage,
} from "@rch/contract";
import { drainOnce } from "../../lib/drain.js";
import { mount, mountedRoutes } from "../../routes.js";
import { buildTestApp, putOutbox, sampleEvent, signToken } from "../../test/app.js";

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let app: TestApp;

/** Role labels as `roleLabelOf` prints them (D5). */
const who = {
  priya: { id: "u1", emp: "RC-4471", name: "Priya Raman", role: "Counter Operator", loc: "coffee" },
  ramesh: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "central" },
  arun: { id: "u3", emp: "RC-2088", name: "Arun Das", role: "Store Keeper", loc: "central" },
  ravi: { id: "u5", emp: "RC-1550", name: "Ravi Menon", role: "Procurement Officer", loc: "central" },
  stranger: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
} satisfies Record<string, AuditActor>;

type Fixture = [key: string, over: Partial<AuditEvent>];
const noDetail = { cause: null, before: null, result: null, changed: [] } satisfies Partial<AuditEvent>;
const signInRefused = { method: "POST", path: "/auth/login", target: "", targetLoc: "", outcome: "refused", status: 401, message: "That employee number and password do not match." } satisfies Partial<AuditEvent>;

/** IST 10 and 11 March 2025. f8 is the last second of the 11th; f9, the first instant of the 12th,
 *  must stay out of that range. The sentences carry the decoys the search cases need: f1's "B-1050"
 *  holds "50" without a "%", and f3's "XJumbo" matches an unescaped "_Jumbo". */
const MARCH: Fixture[] = [
  ["f1", { ...noDetail, at: "2025-03-10T03:30:00.000Z", actor: who.priya, action: "pay", method: "POST", path: "/bills", target: "B-1050", targetLoc: "coffee", outcome: "done", status: 200, message: "Bill B-1050 posted for ₹120" }],
  ["f2", {
    at: "2025-03-10T04:30:00.000Z", actor: who.ramesh, action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "staff:muffin", targetLoc: "",
    outcome: "done", status: 200, message: "Price of 50% Off Muffin_Jumbo saved at ₹45", cause: null,
    request: { params: { list: "staff", it: "muffin" }, query: {}, body: { price: 45 } },
    before: { price: 40 }, result: { list: "staff", it: "muffin", price: 45 }, changed: ["prices"],
    ip: "10.0.4.21", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0",
  }],
  ["f3", { ...noDetail, at: "2025-03-10T05:30:00.000Z", actor: who.ravi, action: "createPo", method: "POST", path: "/purchase-orders", target: "", targetLoc: "", outcome: "refused", status: 422, message: "Refused - XJumbo Foods is inactive", cause: "vendor inactive" }],
  ["f4", { ...noDetail, ...signInRefused, at: "2025-03-10T06:30:00.000Z", actor: who.stranger, action: "login", cause: "unknown employee" }],
  ["f5", { ...noDetail, ...signInRefused, at: "2025-03-10T07:30:00.000Z", actor: who.priya, action: "login", cause: "wrong password" }],
  ["f6", { ...noDetail, at: "2025-03-11T03:30:00.000Z", actor: who.priya, action: "logout", method: "POST", path: "/auth/logout", target: "", targetLoc: "", outcome: "done", status: 200, message: "Signed out." }],
  ["f7", { ...noDetail, at: "2025-03-11T04:30:00.000Z", actor: who.arun, action: "receivePo", method: "POST", path: "/purchase-orders/:id/receive", target: "PO-0007", targetLoc: "central", outcome: "error", status: 500, message: "Something went wrong on our side. Reference f7." }],
  ["f8", { ...noDetail, at: "2025-03-11T18:29:59.000Z", actor: who.ramesh, action: "toggleAvail", method: "POST", path: "/availability/toggle", target: "juice", targetLoc: "rest", outcome: "done", status: 200, message: "Juice marked unavailable at the Restaurant" }],
  ["f9", { ...noDetail, at: "2025-03-11T18:30:00.000Z", actor: who.ramesh, action: "approveRequest", method: "POST", path: "/requests/:id/approve", target: "REQ-0003", targetLoc: "rest", outcome: "done", status: 200, message: "REQ-0003 approved" }],
];
const MARCH_RANGE = { from: "2025-03-10", to: "2025-03-11" };
const IN_RANGE = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];

/** The IST day boundary, read under TZ=UTC. */
const SEPT: Fixture[] = [
  ["g1", { at: "2025-09-13T18:29:59.000Z" }],   // 23:59:59 IST on the 13th
  ["g2", { at: "2025-09-13T18:45:00.000Z" }],   // 00:15 IST on the 14th
  ["g3", { at: "2025-09-14T18:29:59.999Z" }],   // the last millisecond of the 14th in IST
  ["g4", { at: "2025-09-14T18:30:00.000Z" }],   // IST midnight: the 15th
];
/** 25 events at 09:30 IST on 1 June 2025, a second apart, for paging. */
const JUNE: Fixture[] = Array.from({ length: 25 }, (_, i): Fixture => [`p${String(i).padStart(2, "0")}`, { at: new Date(Date.UTC(2025, 5, 1, 4, 0, i)).toISOString() }]);

const ids = new Map<string, number>();
const idsOf = (...keys: string[]): number[] => keys.map((k) => {
  const id = ids.get(k);
  if (id === undefined) throw new Error(`no fixture ${k}`);
  return id;
});

beforeAll(async () => {
  app = await buildTestApp({ schema: "reads", drainer: false });
  await app.ready();
  const t = app.testDb;
  const today: Fixture = ["today", { at: new Date().toISOString() }];
  await putOutbox(t, [...MARCH, ...SEPT, ...JUNE, today].map(([key, over]) => sampleEvent({ ...over, requestId: key })));
  const r = await drainOnce(app.db, { auditSchema: t.auditSchema, outboxSchema: t.outboxSchema, eventsSchema: app.config.eventsSchema, batch: 500 });
  if (r.dead > 0) throw new Error(`fixtures refused: ${JSON.stringify(r.issues)}`);
  const rows = await app.db.execute(sql`select id::int as id, request_id from ${sql.identifier(t.auditSchema)}.events`);
  for (const row of rows.rows as Array<{ id: number; request_id: string }>) ids.set(row.request_id, row.id);
});
afterAll(async () => { await app.close(); });

const adminClaims = { sub: "u0", role: "manager", loc: "central", admin: true };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const asAdmin = () => bearer(signToken(app, adminClaims));
const qs = (query: Record<string, string | number>) =>
  Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
const getLog = (query: Record<string, string | number> = {}, headers: Record<string, string> = asAdmin()) =>
  app.inject({ method: "GET", url: `${API_PREFIX}${AUDIT_PATH}?${qs(query)}`, headers });
const getEntry = (id: number | string, headers: Record<string, string> = asAdmin()) =>
  app.inject({ method: "GET", url: `${API_PREFIX}${AUDIT_PATH}/${id}`, headers });
async function readLog(query: Record<string, string | number> = {}): Promise<AuditPage> {
  const res = await getLog(query);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AuditPage;
}
const idsIn = (page: AuditPage) => page.rows.map((r) => r.id);

describe("GET /admin/audit - filters", () => {
  it("answers the period newest first, one row per event, in the row's own shape", async () => {
    const page = await readLog(MARCH_RANGE);
    expect(idsIn(page)).toEqual(idsOf("f8", "f7", "f6", "f5", "f4", "f3", "f2", "f1"));
    expect(page.next).toBeNull();
    expect(page.rows.at(-1)).toEqual({
      id: idsOf("f1")[0], at: "2025-03-10T03:30:00.000Z", actor: who.priya, action: "pay",
      target: "B-1050", targetLoc: "coffee", outcome: "done", status: 200, message: "Bill B-1050 posted for ₹120",
      requestId: "f1", ip: "10.0.0.7",
    });
    expect(page.rows.find((r) => r.requestId === "f2")?.ip).toBe("10.0.4.21");
  });

  it("narrows to one person", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, actor: "u1" }))).toEqual(idsOf("f6", "f5", "f1"));
  });

  it("narrows to a role as it was printed", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, role: "Store Keeper" }))).toEqual(idsOf("f7"));
  });

  it("narrows to a location the person worked at or the target belonged to", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, loc: "central" }))).toEqual(idsOf("f8", "f7", "f3", "f2"));
    expect(idsIn(await readLog({ ...MARCH_RANGE, loc: "rest" }))).toEqual(idsOf("f8"));
  });

  it("narrows to one outcome", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, outcome: "refused" }))).toEqual(idsOf("f5", "f4", "f3"));
    expect(idsIn(await readLog({ ...MARCH_RANGE, outcome: "error" }))).toEqual(idsOf("f7"));
    expect(idsIn(await readLog({ ...MARCH_RANGE, outcome: "done" }))).toEqual(idsOf("f8", "f6", "f2", "f1"));
  });

  it("narrows to one action", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, action: "login" }))).toEqual(idsOf("f5", "f4"));
  });

  it("narrows to an area through AUDIT_LABELS, and an action outside that area to nothing", async () => {
    expect(actionsInGroup("accounts")).toEqual(expect.arrayContaining(["login", "logout"]));
    for (const group of AUDIT_GROUP_KEYS) {
      const inGroup = new Set(actionsInGroup(group));
      const want = MARCH.filter(([key, over]) => IN_RANGE.includes(key) && inGroup.has(over.action!)).map(([key]) => key).reverse();
      const page = await readLog({ ...MARCH_RANGE, group });
      expect(idsIn(page), group).toEqual(idsOf(...want));
      expect(page.counts.events, group).toBe(want.length);
    }
    expect(idsIn(await readLog({ ...MARCH_RANGE, group: "accounts", action: "login" }))).toEqual(idsOf("f5", "f4"));
    const outside = await readLog({ ...MARCH_RANGE, group: "sales", action: "login" });
    expect(outside.rows).toEqual([]);
    expect(outside.counts.events).toBe(0);
  });

  it("searches target, sentence, name and employee number, ignoring case", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "muffin" }))).toEqual(idsOf("f2"));             // target and sentence
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "PO-0007" }))).toEqual(idsOf("f7"));            // target
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "priya" }))).toEqual(idsOf("f6", "f5", "f1"));  // name
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "rc-9999" }))).toEqual(idsOf("f4"));            // employee number
  });

  it("reads % and _ in a search as the characters themselves", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "50%" }))).toEqual(idsOf("f2"));      // not f1's "B-1050"
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "_Jumbo" }))).toEqual(idsOf("f2"));   // not f3's "XJumbo"
  });

  it("ignores a search of only spaces", async () => {
    expect((await readLog({ ...MARCH_RANGE, q: "   " })).rows).toHaveLength(8);
  });
});

describe("GET /admin/audit - days in Asia/Kolkata", () => {
  it("puts 18:45Z on the 13th on the 14th, and ends the 14th at IST midnight, on a UTC host", async () => {
    expect(new Date(0).getTimezoneOffset()).toBe(0);
    expect(idsIn(await readLog({ from: "2025-09-14", to: "2025-09-14" }))).toEqual(idsOf("g3", "g2"));
    expect(idsIn(await readLog({ from: "2025-09-13", to: "2025-09-13" }))).toEqual(idsOf("g1"));
    expect(idsIn(await readLog({ from: "2025-09-13", to: "2025-09-15" }))).toEqual(idsOf("g4", "g3", "g2", "g1"));
  });

  it("defaults the period to today", async () => {
    expect(idsIn(await readLog())).toEqual(idsOf("today"));
  });

  it("runs a lone from day through today, and takes a lone to day as that day alone", async () => {
    expect(idsIn(await readLog({ from: "2025-09-14" }))).toEqual(idsOf("today", "g4", "g3", "g2"));
    expect(idsIn(await readLog({ to: "2025-09-13" }))).toEqual(idsOf("g1"));
  });

  it("refuses a day the calendar does not have, and a period that ends before it starts", async () => {
    const noSuchFrom = await getLog({ from: "2025-02-30" });
    expect(noSuchFrom.statusCode).toBe(400);
    expect(noSuchFrom.json()).toEqual({ error: { code: "validation", message: "There is no day 2025-02-30 on the calendar." } });
    const noSuchTo = await getLog({ from: "2025-03-10", to: "2025-13-01" });
    expect(noSuchTo.statusCode).toBe(400);
    expect(noSuchTo.json().error.message).toBe("There is no day 2025-13-01 on the calendar.");
    const backwards = await getLog({ from: "2025-03-12", to: "2025-03-10" });
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().error.message).toBe("The period cannot start on 2025-03-12, after it ends on 2025-03-10.");
  });
});

describe("GET /admin/audit - paging and counts", () => {
  it("pages by id without overlap or gaps, and counts the whole filter on every page", async () => {
    const day = { from: "2025-06-01", to: "2025-06-01", limit: 10 };
    const first = await readLog(day);
    const second = await readLog({ ...day, before: first.next! });
    const third = await readLog({ ...day, before: second.next! });

    expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([10, 10, 5]);
    expect(first.next).toBe(first.rows[9].id);
    expect(second.next).toBe(second.rows[9].id);
    expect(third.next).toBeNull();
    const seen = [...idsIn(first), ...idsIn(second), ...idsIn(third)];
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual(idsOf(...JUNE.map(([key]) => key)).sort((a, b) => b - a));
    for (const page of [first, second, third]) expect(page.counts.events).toBe(25);
  });

  it("offers no next page when the last page is exactly full", async () => {
    const page = await readLog({ ...MARCH_RANGE, limit: 8 });
    expect(page.rows).toHaveLength(8);
    expect(page.next).toBeNull();
  });

  it("counts events, people, refusals and failed sign-ins over the whole filter, not the page", async () => {
    const page = await readLog({ ...MARCH_RANGE, limit: 2 });
    expect(idsIn(page)).toEqual(idsOf("f8", "f7"));
    expect(page.next).toBe(idsOf("f7")[0]);
    // People: u1, u2, u3, u5 and the unknown RC-9999, told apart by employee number.
    // Refused: everything not done, errors included (f3, f4, f5, f7).
    expect(page.counts).toEqual({ events: 8, people: 5, refused: 4, failedSignIns: 2 });
    expect((await readLog({ ...MARCH_RANGE, outcome: "refused" })).counts).toEqual({ events: 3, people: 3, refused: 3, failedSignIns: 2 });
  });

  it("refuses a page size outside 1-500", async () => {
    expect((await getLog({ ...MARCH_RANGE, limit: 0 })).statusCode).toBe(400);
    expect((await getLog({ ...MARCH_RANGE, limit: 501 })).statusCode).toBe(400);
  });
});

describe("GET /admin/audit/:id", () => {
  it("answers one entry with what was sent, the before values and the result", async () => {
    const [id] = idsOf("f2");
    const res = await getEntry(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      id, at: "2025-03-10T04:30:00.000Z", actor: who.ramesh, action: "savePrice", target: "staff:muffin", targetLoc: "",
      outcome: "done", status: 200, message: "Price of 50% Off Muffin_Jumbo saved at ₹45", requestId: "f2", ip: "10.0.4.21",
      method: "PUT", path: "/prices/:list/:it", cause: null,
      request: { params: { list: "staff", it: "muffin" }, query: {}, body: { price: 45 } },
      before: { price: 40 }, result: { list: "staff", it: "muffin", price: 45 }, changed: ["prices"],
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0",
    } satisfies AuditEntry);
  });

  it("answers a refused sign-in by an unknown employee with its cause and no actor id", async () => {
    const res = await getEntry(idsOf("f4")[0]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actor: who.stranger, action: "login", outcome: "refused", cause: "unknown employee", before: null, result: null, changed: [] });
  });

  it("answers an id that is not in the log with a 404 sentence", async () => {
    const res = await getEntry(987654321);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "There is no audit entry 987654321." } });
  });

  it("refuses an id that is not a number", async () => {
    expect((await getEntry("abc")).statusCode).toBe(400);
  });
});

describe("who may read the log", () => {
  it("asks anyone without a token to sign in, on both routes", async () => {
    for (const res of [await getLog(MARCH_RANGE, {}), await getEntry(idsOf("f1")[0], {})]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } });
    }
  });

  it("asks for sign-in again for a token that is not a JWT, or that the API did not sign", async () => {
    expect((await getLog(MARCH_RANGE, bearer("not-a-token"))).statusCode).toBe(401);
    const { privateKey } = generateKeyPairSync("ed25519");
    const forged = createSigner({ key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), algorithm: "EdDSA", iss: "rch-api" })(adminClaims);
    expect((await getLog(MARCH_RANGE, bearer(forged))).statusCode).toBe(401);
  });

  it("accepts a token signed with the previous key", async () => {
    const res = await getLog(MARCH_RANGE, bearer(signToken(app, adminClaims, { previousKey: true })));
    expect(res.statusCode, res.body).toBe(200);
  });

  it("answers a signed-in account without the admin flag with a 404, even for a malformed query", async () => {
    const counter = bearer(signToken(app, { sub: "u1", role: "counter", loc: "coffee", admin: false }));
    for (const res of [await getLog(MARCH_RANGE, counter), await getEntry(idsOf("f1")[0], counter), await getLog({ limit: 0 }, counter)]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("refuses an admin who must still change their password", async () => {
    const res = await getLog(MARCH_RANGE, bearer(signToken(app, { ...adminClaims, mcp: true })));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: "forbidden", message: "Change your password before you carry on." } });
  });
});

describe("mount", () => {
  it("mounts every route the manifest gives the audit service", () => {
    const tagged = Object.values(routes).filter((r) => serviceOf(r) === "audit").map((r) => `${r.method} ${r.path}`);
    expect(tagged.length).toBeGreaterThan(0);
    expect([...mountedRoutes].sort()).toEqual(tagged.sort());
  });

  it("refuses a route that belongs to the API", () => {
    expect(() => mount(app, routes.adminUsers, async () => [])).toThrow("is served by the api service");
  });

  it("refuses an audit route that is not admin-only", () => {
    const probe = defineRoute({ method: "GET", path: "/admin/audit/probe", access: "any", service: "audit", response: z.strictObject({}) });
    expect(() => mount(app, probe, async () => ({}))).toThrow("is not an admin route");
  });
});
