import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { defineRoute, OkResponseSchema } from "@rch/contract";
import { buildTestApp, testConfig } from "../test/app.js";
import { seedTestDb } from "../test/seed.js";
import { warmPool } from "../test/db.js";
import { authHeaders } from "../test/auth.js";
import { buildApp, type App } from "../app.js";
import { mount } from "../routes.js";
import { idemHooks, purgeIdempotencyKeys } from "./idempotency.js";
import { withTransaction } from "../lib/db.js";
import { RuleError } from "../lib/errors.js";
import { bills, documentHistory, idempotencyKeys, stockMoves, tickets, users } from "../db/schema/index.js";
import { meRepo } from "../modules/me/repo.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "idem" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

const countRows = async (table: PgTable): Promise<number> => {
  const r = await app.db.execute(sql`select count(*)::int as n from ${table}`);
  return Number((r.rows[0] as { n: number }).n);
};
const claimRow = async (key: string) => (await app.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)))[0];
const phoneOf = async (id: string) => (await app.db.select().from(users).where(eq(users.id, id)))[0].phone;
/** How many wrong codes the seeded ticket has taken — the one figure a refused handover is
 *  allowed to commit, and therefore the one thing a replay must not add to. */
const otpAttempts = async (id: string) => (await app.db.select().from(tickets).where(eq(tickets.id, id)))[0].otpAttempts;

/** An app of its own carrying a test-only write, mounted through the real `mount()` so the
 *  route picks up the same authenticate → roleGate → idempotency chain a module's write does,
 *  and sharing this file's already-migrated schema so it seeds nothing. */
async function appWith(register: (a: App) => void, env: Partial<NodeJS.ProcessEnv> = {}): Promise<App> {
  const a = await buildApp(testConfig(env), { db: app.db, migrationsSchema: app.testDb!.schemaName });
  register(a);
  await a.ready();
  return a;
}

/** A write that commits a real change and then answers with a body its own schema refuses —
 *  driven twice below, once on the bench and once with `NODE_ENV=production`, because the two
 *  answer it differently on purpose. */
const badShapeRoute = defineRoute({ method: "POST", path: "/__test/bad-shape", access: "any", response: OkResponseSchema });
const badShapeHandler = (phone: string) => async () => withTransaction(app.db, async (tx) => {
  await meRepo.update(tx, "u2", { phone });
  return { ok: "yes" } as never; // OkResponseSchema wants the literal `true`
});

/** Promise.withResolvers, which the ES2023 lib this package targets does not declare yet. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Idempotency-Key", () => {
  it("is required on writes", async () => {
    const r = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: await authHeaders(app, "u1"), payload: { ph: "10000 00001" } });
    expect(r.statusCode).toBe(400); expect(r.json().error.message).toMatch(/Idempotency-Key/);
  });
  it("replays the stored response for the same key and body", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const a = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "11111 11111" } });
    const b = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "11111 11111" } });
    expect(b.statusCode).toBe(a.statusCode); expect(b.body).toBe(a.body); expect(b.headers["idempotency-replayed"]).toBe("true");
    expect(a.headers["idempotency-replayed"]).toBeUndefined();
  });
  it("a replay does not re-run the write", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const spy = vi.spyOn(meRepo, "update");
    const a = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "50000 00005" } });
    expect(a.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const b = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "50000 00005" } });
    expect(b.statusCode).toBe(200);
    expect(b.headers["idempotency-replayed"]).toBe("true");
    expect(spy).toHaveBeenCalledTimes(1); // still just once - the replay never reached the repo
    spy.mockRestore();
  });
  it("refuses the same key with a different body", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "22222 22222" } });
    const r = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "33333 33333" } });
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe("conflict");
  });
  it("keys are per user", async () => {
    const key = randomUUID();
    const a = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...(await authHeaders(app, "u1")), "idempotency-key": key }, payload: { ph: "40000 00004" } });
    const b = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...(await authHeaders(app, "u2")), "idempotency-key": key }, payload: { ph: "40000 00004" } });
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200); expect(b.headers["idempotency-replayed"]).toBeUndefined();
  });
  it("lets exactly one of two concurrent requests with the same key through", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const send = () => app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "60000 00006" } });
    // Park the first request inside its own write so the second provably overlaps it. Racing
    // two injections and hoping is not a test - it passes or fails on the scheduler's mood.
    const entered = deferred(); const release = deferred();
    const real = meRepo.update;
    const parked: typeof meRepo.update = (tx, id, patch) => {
      entered.resolve();
      return release.promise.then(() => real(tx, id, patch)) as unknown as ReturnType<typeof meRepo.update>;
    };
    const spy = vi.spyOn(meRepo, "update").mockImplementation(parked);
    const first = send();
    await entered.promise;
    const second = await send();
    release.resolve();
    const winner = await first;
    expect(winner.statusCode).toBe(200);
    // The loser is told to come back rather than quietly running the write a second time.
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("conflict");
    expect(second.json().error.message).toMatch(/still being processed/);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    // And once the winner has finished, the same key replays its response.
    const again = await send();
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe(winner.body);
    expect(again.headers["idempotency-replayed"]).toBe("true");
  });
  it("takes over a claim abandoned by a crash", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const payload = { ph: "70000 00007" };
    expect((await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload })).statusCode).toBe(200);
    // Rewind the row to what a request that died *before* its transaction committed leaves
    // behind: a claim with no response and no `committed_at`. Fresh, it blocks; a minute old,
    // it is fair game. A row that does carry `committed_at` never is, however old — the write
    // behind it happened, and that is the case two tests further down.
    const claim = { statusCode: 0, response: sql`'null'::jsonb`, committedAt: null };
    const where = eq(idempotencyKeys.key, key);
    await app.db.update(idempotencyKeys).set({ ...claim, createdAt: new Date() }).where(where);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload })).statusCode).toBe(409);
    // Comfortably past CLAIM_STALE_MS (120_000) - a bare 120_000 would sit right on the
    // boundary and could flake depending on how much wall-clock time elapses between this
    // write and the request below.
    await app.db.update(idempotencyKeys).set({ ...claim, createdAt: new Date(Date.now() - 130_000) }).where(where);
    const retry = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["idempotency-replayed"]).toBeUndefined();
  });
  it("never records a 429 from the rate limiter as the idempotent outcome", async () => {
    // A dedicated app with a tiny budget, sharing `app`'s already-migrated schema/db so this
    // test does not have to seed or migrate anything of its own, and does not drag every other
    // test in this file onto a shared limiter (see security.test.ts for the same pattern).
    const throttled = await buildApp(testConfig({ RATE_LIMIT_PER_MINUTE: "10" }), { db: app.db, migrationsSchema: app.testDb!.schemaName });
    await throttled.ready();
    try {
      const h = await authHeaders(throttled, "u1");
      // Burn the budget with reads: they need no Idempotency-Key, so none of this leaves a claim.
      for (let i = 0; i < 10; i++) {
        expect((await throttled.inject({ method: "GET", url: "/api/v1/me", headers: h })).statusCode, `read ${i + 1}`).toBe(200);
      }
      const key = randomUUID();
      const r = await throttled.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...h, "idempotency-key": key }, payload: { ph: "80000 00008" } });
      expect(r.statusCode).toBe(429);
      expect((await app.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key))).length).toBe(0);
      // The claim is gone, so retrying the same key is a fresh attempt rather than a replay -
      // even though it is still throttled (the budget has not refilled).
      const retry = await throttled.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...h, "idempotency-key": key }, payload: { ph: "80000 00008" } });
      expect(retry.statusCode).toBe(429);
      expect(retry.headers["idempotency-replayed"]).toBeUndefined();
    } finally {
      await throttled.close();
    }
  });
  it("never records a transient 503 as the idempotent outcome", async () => {
    // A test-only write route, mounted (via the real `mount()` a module would use) before
    // `ready()` so it picks up the same authenticate -> roleGate -> idempotency preHandler
    // chain as a real write, then made to fail the way an overloaded dependency would.
    const boomRoute = defineRoute({ method: "POST", path: "/__test/boom", access: "any", response: OkResponseSchema });
    const boomApp = await buildApp(testConfig(), { db: app.db, migrationsSchema: app.testDb!.schemaName });
    mount(boomApp, boomRoute, async () => {
      const err = new Error("simulated overload");
      (err as { statusCode?: number }).statusCode = 503;
      throw err;
    });
    await boomApp.ready();
    try {
      const h = await authHeaders(boomApp, "u1");
      const key = randomUUID();
      const r = await boomApp.inject({ method: "POST", url: "/api/v1/__test/boom", headers: { ...h, "idempotency-key": key } });
      expect(r.statusCode).toBe(503);
      expect((await app.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key))).length).toBe(0);
    } finally {
      await boomApp.close();
    }
  });
  it("records the response as the last statement before COMMIT, with committed_at set", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const r = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "90000 00009" } });
    expect(r.statusCode, r.body).toBe(200);
    const row = await claimRow(key);
    // Written by the write's own transaction, not by a hook afterwards: the stamp says so, and
    // the body stored is the parsed response, so a replay serialises the same bytes.
    expect(row.statusCode).toBe(200);
    expect(row.committedAt).toBeInstanceOf(Date);
    expect(row.response).toEqual(r.json());
  });

  it("a crash after commit still replays the stored body and writes nothing", async () => {
    // The pod dies between COMMIT and the response hooks: the transaction's own record is all
    // that is left, and it has to be enough.
    const key = randomUUID();
    const headers = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const payload = { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] };
    const spy = vi.spyOn(idemHooks, "recordAfterSend").mockResolvedValue(undefined);
    const first = await app.inject({ method: "POST", url: "/api/v1/bills", headers, payload });
    spy.mockRestore();
    expect(first.statusCode, first.body).toBe(200);
    expect((await claimRow(key)).committedAt).toBeInstanceOf(Date);

    const billsBefore = await countRows(bills); const movesBefore = await countRows(stockMoves);
    const again = await app.inject({ method: "POST", url: "/api/v1/bills", headers, payload });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.body).toBe(first.body);
    expect(await countRows(bills)).toBe(billsBefore);       // no second bill
    expect(await countRows(stockMoves)).toBe(movesBefore);  // and no second deduction
  });

  it("never deletes a claim whose transaction already committed", async () => {
    // The write commits, then the request falls over on the way out. The old hook deleted the
    // claim on any 5xx, so the client's retry ran the write again; now the commit stamp is what
    // the delete is guarded on.
    const route = defineRoute({ method: "POST", path: "/__test/late-boom", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => {
      await withTransaction(app.db, async (tx) => { await meRepo.update(tx, "u1", { phone: "12121 21212" }); return { ok: true } as const; });
      const err = new Error("died on the way out"); (err as { statusCode?: number }).statusCode = 503; throw err;
    }));
    try {
      const key = randomUUID();
      const headers = { ...(await authHeaders(a, "u1")), "idempotency-key": key };
      const r = await a.inject({ method: "POST", url: "/api/v1/__test/late-boom", headers });
      expect(r.statusCode).toBe(503);
      expect(await phoneOf("u1")).toBe("12121 21212"); // the transaction did commit
      const row = await claimRow(key);
      expect(row.committedAt).toBeInstanceOf(Date);
      expect(row.statusCode).toBe(200);
      const retry = await a.inject({ method: "POST", url: "/api/v1/__test/late-boom", headers });
      expect(retry.statusCode).toBe(200);
      expect(retry.headers["idempotency-replayed"]).toBe("true");
      expect(retry.json()).toEqual({ ok: true });
    } finally {
      await a.close();
    }
  });

  it("still deletes an uncommitted claim on a 429 and on a 503", async () => {
    // The other half of the same guard: nothing committed, so nothing worth replaying.
    const route = defineRoute({ method: "POST", path: "/__test/early-boom", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => {
      const err = new Error("simulated overload"); (err as { statusCode?: number }).statusCode = 503; throw err;
    }), { RATE_LIMIT_PER_MINUTE: "10" });
    try {
      const h = await authHeaders(a, "u2");
      const boomKey = randomUUID();
      expect((await a.inject({ method: "POST", url: "/api/v1/__test/early-boom", headers: { ...h, "idempotency-key": boomKey } })).statusCode).toBe(503);
      expect(await claimRow(boomKey)).toBeUndefined();
      // Burn what is left of the budget on reads (no Idempotency-Key, so no claims), then the
      // next write is throttled before it ever runs.
      for (let i = 0; i < 10; i++) await a.inject({ method: "GET", url: "/api/v1/me", headers: h });
      const throttledKey = randomUUID();
      const r = await a.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...h, "idempotency-key": throttledKey }, payload: { ph: "13131 31313" } });
      expect(r.statusCode).toBe(429);
      expect(await claimRow(throttledKey)).toBeUndefined();
    } finally {
      await a.close();
    }
  });

  it("refuses to take over a claim that carries committed_at, however old it is", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const payload = { ph: "14141 41414" };
    expect((await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload })).statusCode).toBe(200);
    const spy = vi.spyOn(meRepo, "update");
    // Age it far past CLAIM_STALE_MS. A committed row still answers with its stored response.
    await app.db.update(idempotencyKeys).set({ createdAt: new Date(Date.now() - 130_000) }).where(eq(idempotencyKeys.key, key));
    const replay = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    // And torn down to a bare claim — the shape a takeover is for — the stamp still refuses it,
    // because a committed write is not a write to run again.
    await app.db.update(idempotencyKeys)
      .set({ statusCode: 0, response: sql`'null'::jsonb`, createdAt: new Date(Date.now() - 130_000) })
      .where(eq(idempotencyKeys.key, key));
    const refused = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/still being processed/);
    expect(spy).not.toHaveBeenCalled(); // neither attempt reached the write
    spy.mockRestore();
  });

  it("refuses to overwrite a takeover winner's record, and rolls the straggler back", async () => {
    // The race the `committed_at is null` guard on the record's own UPDATE exists for: a request
    // slow enough to be declared abandoned has its claim taken over and the write re-run, and
    // then finishes. Its answer must not land on top of the winner's, and its write must not
    // stand beside the winner's either.
    await warmPool(app.testDb!, 2); // or the two "concurrent" transactions run back to back
    const marker = `IDEM-${randomUUID().slice(0, 8)}`;
    const route = defineRoute({ method: "POST", path: "/__test/slow-write", access: "any", response: OkResponseSchema });
    const entered = deferred(); const release = deferred();
    let gate: { promise: Promise<void>; resolve: () => void } | null = release;
    const a = await appWith((x) => mount(x, route, async () => withTransaction(app.db, async (tx) => {
      await tx.insert(documentHistory).values({ docType: marker, docId: marker, status: "written", who: "u1" });
      const mine = gate; gate = null; // only the first attempt parks; the takeover runs straight through
      if (mine) { entered.resolve(); await mine.promise; }
      return { ok: true } as const;
    })));
    try {
      const key = randomUUID();
      const headers = { ...(await authHeaders(a, "u1")), "idempotency-key": key };
      const send = () => a.inject({ method: "POST", url: "/api/v1/__test/slow-write", headers });
      const straggler = send();
      await entered.promise;
      // Age the claim past CLAIM_STALE_MS while its owner is still inside the write — the shape
      // a dead pod leaves, and the only thing a takeover is allowed to act on.
      await app.db.update(idempotencyKeys).set({ createdAt: new Date(Date.now() - 130_000) }).where(eq(idempotencyKeys.key, key));
      const winner = await send();
      expect(winner.statusCode, winner.body).toBe(200);
      release.resolve();
      const late = await straggler;
      expect(late.statusCode).toBe(500);                  // the straggler's own record found the row taken
      const row = await claimRow(key);
      expect(row.committedAt).toBeInstanceOf(Date);       // the winner's record survives the straggler's 5xx
      expect(row.response).toEqual(winner.json());
      const written = await app.db.select().from(documentHistory).where(eq(documentHistory.docType, marker));
      expect(written.length).toBe(1);                     // one write stands, not two
    } finally {
      await a.close();
    }
  });

  it("rolls the write back when its own response does not match its schema", async () => {
    // A response the route's own schema refuses can never reach the client and can never be
    // replayed, so on the bench (`config.env !== "production"`) it takes the write down with it
    // rather than leaving a change nobody's key knows about.
    const before = await phoneOf("u2");
    const a = await appWith((x) => mount(x, badShapeRoute, badShapeHandler("15151 51515")));
    try {
      const key = randomUUID();
      const headers = { ...(await authHeaders(a, "u2")), "idempotency-key": key };
      const r = await a.inject({ method: "POST", url: "/api/v1/__test/bad-shape", headers });
      expect(r.statusCode).toBe(500);
      expect(await phoneOf("u2")).toBe(before);     // rolled back
      expect(await claimRow(key)).toBeUndefined();  // and the uncommitted claim is gone
    } finally {
      await a.close();
    }
  });

  it("in production a response that fails its schema leaves the write standing and falls back to onSend", async () => {
    // The branch that actually ships: the chart sets NODE_ENV=production in every namespace, so
    // `strict` is off there and a response-shape bug must degrade to the behaviour this plugin
    // has always had rather than start refusing the hospital's writes.
    const a = await appWith((x) => mount(x, badShapeRoute, badShapeHandler("18181 81818")), { NODE_ENV: "production" });
    try {
      const key = randomUUID();
      const headers = { ...(await authHeaders(a, "u2")), "idempotency-key": key };
      const r = await a.inject({ method: "POST", url: "/api/v1/__test/bad-shape", headers });
      // The serializer refuses the body exactly as it did before any of this, and nothing the
      // record does turns that into a different failure.
      expect(r.statusCode).toBe(500);
      expect(r.json().error.code).toBe("internal");
      expect(await phoneOf("u2")).toBe("18181 81818");  // the write stands
      expect(await claimRow(key)).toBeUndefined();      // nothing was committed, so onSend drops the claim
      // …which leaves the retry a clean first attempt rather than a stuck replay.
      const retry = await a.inject({ method: "POST", url: "/api/v1/__test/bad-shape", headers });
      expect(retry.statusCode).toBe(500);
      expect(retry.headers["idempotency-replayed"]).toBeUndefined();
    } finally {
      await a.close();
    }
  });

  it("records a refusal in onSend, so a re-sent 422 replays the same sentence", async () => {
    // A refusal rolls its transaction back, so there is nothing for the record inside it to do
    // — the hook is still what stores a 4xx, and the sentence the operator read is what comes
    // back if the same key is re-sent.
    const sentence = "Refused — the Coffee Shop is closed for stock-take until 4 pm";
    const route = defineRoute({ method: "POST", path: "/__test/refusal", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => { throw new RuleError(sentence); }));
    try {
      const key = randomUUID();
      const headers = { ...(await authHeaders(a, "u1")), "idempotency-key": key };
      const first = await a.inject({ method: "POST", url: "/api/v1/__test/refusal", headers });
      expect(first.statusCode).toBe(422);
      expect(first.json().error.message).toBe(sentence);
      const row = await claimRow(key);
      expect(row.statusCode).toBe(422);
      expect(row.committedAt).toBeNull(); // nothing committed — a refusal is not an outcome to protect
      const again = await a.inject({ method: "POST", url: "/api/v1/__test/refusal", headers });
      expect(again.statusCode).toBe(422);
      expect(again.headers["idempotency-replayed"]).toBe("true");
      expect(again.json().error.message).toBe(sentence);
    } finally {
      await a.close();
    }
  });

  it("a write that commits a refusal counter and then refuses replays the refusal, and the counter stands", async () => {
    // The one write in the server that must commit something and then refuse: a wrong OTP is
    // counted (or a caller could guess for ever) and the sentence is thrown after the commit.
    // Its transaction therefore returns a marker the route's schema refuses — `withTransaction`
    // is told `response: "optional"` so that marker records nothing and throws nothing, instead
    // of taking the committed count down with it and answering 500.
    const key = randomUUID();
    const headers = { ...(await authHeaders(app, "u3")), "idempotency-key": key };
    const send = () => app.inject({ method: "POST", url: "/api/v1/tickets/TKT-0440/handover", headers, payload: { otp: "000000" } });

    const first = await send();
    expect(first.statusCode, first.body).toBe(422);
    expect(first.json().error.message).toBe("That OTP does not match TKT-0440. Ask the collector to read it again.");
    expect(await otpAttempts("TKT-0440")).toBe(1);
    // A refusal is `onSend`'s to record, exactly as it always was — nothing committed that a
    // retry could duplicate, so the row carries no commit stamp.
    const row = await claimRow(key);
    expect(row.statusCode).toBe(422);
    expect(row.committedAt).toBeNull();

    const again = await send();
    expect(again.statusCode).toBe(422);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.body).toBe(first.body);
    // The replay ran nothing, so the guess it repeats is not a second guess.
    expect(await otpAttempts("TKT-0440")).toBe(1);
  });

  it("a correct handover after a wrong code is recorded inside its own transaction", async () => {
    // The other half of `response: "optional"`: a value that does match the route's schema is
    // still recorded by the write's own transaction, so the success path is untouched.
    const guesses = await otpAttempts("TKT-0440");   // the case above left its own behind
    const wrong = await app.inject({
      method: "POST", url: "/api/v1/tickets/TKT-0440/handover",
      headers: { ...(await authHeaders(app, "u3")), "idempotency-key": randomUUID() }, payload: { otp: "000000" },
    });
    expect(wrong.statusCode).toBe(422);
    expect(await otpAttempts("TKT-0440")).toBe(guesses + 1);

    const key = randomUUID();
    const r = await app.inject({
      method: "POST", url: "/api/v1/tickets/TKT-0440/handover",
      headers: { ...(await authHeaders(app, "u3")), "idempotency-key": key }, payload: { otp: "418327" },
    });
    expect(r.statusCode, r.body).toBe(200);
    const row = await claimRow(key);
    expect(row.committedAt).toBeInstanceOf(Date);
    expect(row.statusCode).toBe(200);
    expect(row.response).toEqual(r.json());
  });

  it("every write this suite drives leaves recorded = true", async () => {
    const keys = { pay: randomUUID(), patchMe: randomUUID(), addVendor: randomUUID() };
    const pay = await app.inject({
      method: "POST", url: "/api/v1/bills",
      headers: { ...(await authHeaders(app, "u1")), "idempotency-key": keys.pay },
      payload: { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] },
    });
    expect(pay.statusCode, pay.body).toBe(200);
    const patchMe = await app.inject({
      method: "PATCH", url: "/api/v1/me",
      headers: { ...(await authHeaders(app, "u1")), "idempotency-key": keys.patchMe },
      payload: { ph: "16161 61616" },
    });
    expect(patchMe.statusCode, patchMe.body).toBe(200);
    const addVendor = await app.inject({
      method: "POST", url: "/api/v1/vendors",
      headers: { ...(await authHeaders(app, "u5")), "idempotency-key": keys.addVendor },
      payload: { n: `Sakthi Provisions ${randomUUID().slice(0, 8)}` },
    });
    expect(addVendor.statusCode, addVendor.body).toBe(200);
    for (const [name, key] of Object.entries(keys)) {
      const row = await claimRow(key);
      expect(row.committedAt, name).toBeInstanceOf(Date);
      expect(row.statusCode, name).toBe(200);
    }
  });

  it("purge removes expired rows only", async () => {
    await app.db.update(idempotencyKeys).set({ expiresAt: new Date(Date.now() - 1000) });
    const n = await purgeIdempotencyKeys(app.db);
    expect(n).toBeGreaterThan(0);
    expect((await app.db.select().from(idempotencyKeys)).length).toBe(0);
  });
});
