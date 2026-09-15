import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client, type Pool } from "pg";
import { buildTestApp, putOutbox, sampleEvent } from "../test/app.js";
import { resetAudit } from "../test/db.js";
import { drainOnce, EVENTS_CHANNEL_PREFIX, outboxStats, type DrainTarget } from "./drain.js";

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let app: TestApp;

beforeAll(async () => {
  app = await buildTestApp({ schema: "drain", drainer: false });
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetAudit(app.testDb); });

const target = (batch = 500): DrainTarget => ({
  auditSchema: app.testDb.auditSchema, outboxSchema: app.testDb.outboxSchema, eventsSchema: app.config.eventsSchema, batch,
});
const drain = (batch?: number) => drainOnce(app.db, target(batch));
const tag = () => randomUUID();
const events = (t: string, n: number) =>
  Array.from({ length: n }, (_, i) => sampleEvent({ requestId: `${t}-${String(i).padStart(3, "0")}` }));
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function outboxIds(): Promise<string[]> {
  // The table alias keeps `order by o.id` bound to the actual bigint column: Postgres resolves a
  // bare `order by id` against an output column named `id` first, which would sort textually
  // ("1", "10", "2", ...) instead of numerically once a batch reaches double digits.
  const r = await app.db.execute(sql`select id::text as id from ${sql.identifier(app.testDb.outboxSchema)}.audit_outbox o order by o.id`);
  return (r.rows as Array<{ id: string }>).map((x) => x.id);
}
async function stored(t: string): Promise<Array<{ outbox_id: string; request_id: string }>> {
  const r = await app.db.execute(sql`
    select outbox_id::text as outbox_id, request_id from ${sql.identifier(app.testDb.auditSchema)}.events
    where request_id like ${`${t}-%`} order by id`);
  return r.rows as Array<{ outbox_id: string; request_id: string }>;
}
/** `pg` connects lazily, so two drains started in one tick against a pool that has only ever
 *  needed one client run back to back, and a race test passes whether or not anything is locked.
 *  As `apps/api/src/test/db.ts`'s `warmPool`; n stays within the harness pool's 4. */
async function warmPool(pool: Pool, n: number): Promise<void> {
  const held = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const c of held) c.release();
}

describe("drainOnce", () => {
  it("moves every outbox row into the log once, in outbox order, and leaves the outbox empty", async () => {
    const t = tag();
    const sent = events(t, 10);
    await putOutbox(app.testDb, sent);
    const ids = await outboxIds();

    expect(await drain()).toEqual({ moved: 10, dead: 0, issues: [] });

    const rows = await stored(t);
    expect(rows.map((r) => r.request_id)).toEqual(sent.map((e) => e.requestId));
    expect(rows.map((r) => r.outbox_id)).toEqual(ids);
    expect(await outboxIds()).toEqual([]);
    // Nothing left to take, and nothing taken twice.
    expect(await drain()).toEqual({ moved: 0, dead: 0, issues: [] });
    expect(await stored(t)).toHaveLength(10);
  });

  it("stores each field of the event in its own column", async () => {
    const t = tag();
    const edit = sampleEvent({
      at: "2025-09-13T18:45:00.123Z", requestId: `${t}-000`,
      actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
      action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "staff:muffin", targetLoc: "",
      outcome: "done", status: 200, message: "Price of Muffin saved at ₹45", cause: null,
      request: { params: { list: "staff", it: "muffin" }, query: {}, body: { price: 45 } },
      before: { price: 40 }, result: { list: "staff", it: "muffin", price: 45 }, changed: ["prices"],
      ip: "10.0.0.7", userAgent: "Mozilla/5.0",
    });
    const stranger = sampleEvent({
      requestId: `${t}-001`, actor: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
      action: "login", outcome: "refused", status: 401, cause: "unknown employee",
      request: null, before: null, result: null, changed: [],
    });
    await putOutbox(app.testDb, [edit, stranger]);
    const ids = await outboxIds();

    expect(await drain()).toEqual({ moved: 2, dead: 0, issues: [] });

    const r = await app.db.execute(sql`
      select outbox_id::text as outbox_id, at = ${edit.at}::timestamptz as same_at, request_id,
             actor_id, actor_emp, actor_name, actor_role, actor_loc, action, method, path, target, target_loc,
             outcome, status, message, cause, request, before, result, changed, ip, user_agent
      from ${sql.identifier(app.testDb.auditSchema)}.events where request_id like ${`${t}-%`} order by id`);
    expect(r.rows[0]).toEqual({
      outbox_id: ids[0], same_at: true, request_id: edit.requestId,
      actor_id: "u2", actor_emp: "RC-3120", actor_name: "Ramesh Kumar", actor_role: "Outlet Manager", actor_loc: "rest",
      action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "staff:muffin", target_loc: "",
      outcome: "done", status: 200, message: "Price of Muffin saved at ₹45", cause: null,
      request: edit.request, before: { price: 40 }, result: edit.result, changed: ["prices"], ip: "10.0.0.7", user_agent: "Mozilla/5.0",
    });
    // A refused sign-in by an unknown id: no actor id, no before/result, and a null request stored as {}.
    expect(r.rows[1]).toMatchObject({
      outbox_id: ids[1], actor_id: null, actor_emp: "RC-9999", outcome: "refused", status: 401, cause: "unknown employee",
      request: {}, before: null, result: null, changed: [],
    });
  });

  it("takes at most one batch per pass, oldest first", async () => {
    const t = tag();
    const sent = events(t, 7);
    await putOutbox(app.testDb, sent);
    const moved: number[] = [];
    for (let i = 0; i < 4; i++) moved.push((await drain(3)).moved);
    expect(moved).toEqual([3, 3, 1, 0]);
    expect((await stored(t)).map((r) => r.request_id)).toEqual(sent.map((e) => e.requestId));
  });

  it("sets an invalid event aside in dead_letters with its first issue, and still moves its neighbours", async () => {
    const t = tag();
    const [a, b, c] = events(t, 3);
    const wrong = { ...sampleEvent({ requestId: `${t}-bad` }), outcome: "maybe" };
    await putOutbox(app.testDb, [a, wrong, "not an event", b, c]);
    const ids = await outboxIds();

    const r = await drain();

    expect(r.moved).toBe(3);
    expect(r.dead).toBe(2);
    expect(r.issues).toEqual([
      { outboxId: Number(ids[1]), issue: expect.stringMatching(/^outcome: /) },
      { outboxId: Number(ids[2]), issue: expect.stringMatching(/expected object/) },
    ]);
    expect((await stored(t)).map((x) => x.outbox_id)).toEqual([ids[0], ids[3], ids[4]]);
    const dead = await app.db.execute(sql`
      select outbox_id::text as outbox_id, event, issue from ${sql.identifier(app.testDb.auditSchema)}.dead_letters order by id`);
    expect(dead.rows).toEqual([
      { outbox_id: ids[1], event: wrong, issue: r.issues[0].issue },
      { outbox_id: ids[2], event: "not an event", issue: r.issues[1].issue },
    ]);
    expect(await outboxIds()).toEqual([]);
  });

  it("sets aside an event the database refuses, instead of stalling on it, and still moves the rest", async () => {
    const t = tag();
    const [a, b] = events(t, 2);
    // Valid by the schema (`z.number().int()`), out of range for the `smallint` column.
    const huge = sampleEvent({ requestId: `${t}-huge`, status: 70000 });
    await putOutbox(app.testDb, [a, huge, b]);
    const ids = await outboxIds();

    expect(await drain()).toEqual({
      moved: 2, dead: 1,
      issues: [{ outboxId: Number(ids[1]), issue: expect.stringMatching(/^database refused it: .*smallint/) }],
    });
    expect((await stored(t)).map((x) => x.outbox_id)).toEqual([ids[0], ids[2]]);
  });

  it("never stores one outbox row twice: a repeated outbox id is set aside by the unique backstop", async () => {
    const t = tag();
    await putOutbox(app.testDb, events(t, 1));
    const [id] = await outboxIds();
    await drain();
    // An outbox id handed out again, as after a restore that reset the identity.
    await app.pool.query(
      `insert into "${app.testDb.outboxSchema}".audit_outbox (id, event) overriding system value values ($1, $2::jsonb)`,
      [id, JSON.stringify(sampleEvent({ requestId: `${t}-again` }))],
    );

    expect(await drain()).toEqual({
      moved: 0, dead: 1,
      issues: [{ outboxId: Number(id), issue: expect.stringMatching(/^database refused it: duplicate key/) }],
    });
    expect((await stored(t)).map((x) => x.request_id)).toEqual([`${t}-000`]);
  });

  it("announces stored events on the API's change channel, and stays quiet when nothing was stored", async () => {
    const listener = new Client({ connectionString: app.config.databaseUrl });
    await listener.connect();
    const notices: string[] = [];
    listener.on("notification", (m) => { notices.push(m.payload ?? ""); });
    await listener.query(`listen "${EVENTS_CHANNEL_PREFIX}${app.config.eventsSchema}"`);
    try {
      await drain();                                        // nothing waiting
      await putOutbox(app.testDb, ["not an event"]);
      expect((await drain()).dead).toBe(1);                 // only a dead letter: nothing for a screen to show
      await settle(300);
      expect(notices).toEqual([]);

      await putOutbox(app.testDb, events(tag(), 2));
      expect((await drain()).moved).toBe(2);
      const stop = Date.now() + 2000;
      while (notices.length === 0 && Date.now() < stop) await settle(25);
      expect(notices).toHaveLength(1);
      const notice = JSON.parse(notices[0]) as { collections: string[]; at: string };
      expect(notice.collections).toEqual(["audit"]);
      expect(Number.isNaN(Date.parse(notice.at))).toBe(false);
    } finally {
      await listener.end();
    }
  });

  it("samples the outbox's depth and the age of its oldest row", async () => {
    await putOutbox(app.testDb, events(tag(), 3));
    const waiting = await outboxStats(app.db, app.testDb.outboxSchema);
    expect(waiting.depth).toBe(3);
    expect(waiting.lagSeconds).toBeGreaterThan(0);
    await drain();
    expect(await outboxStats(app.db, app.testDb.outboxSchema)).toEqual({ depth: 0, lagSeconds: 0 });
  });

  it("lets two drainers run side by side and stores each event exactly once", async () => {
    const t = tag();
    await putOutbox(app.testDb, events(t, 200));
    await warmPool(app.pool, 2);

    const [a, b] = await Promise.all([drain(100), drain(100)]);

    // Each pass locked its own hundred. Without a locking clause the second reads the same hundred
    // ids, waits for the first to delete them, deletes nothing, and a hundred stay behind.
    expect([a.moved, b.moved]).toEqual([100, 100]);
    expect(await outboxIds()).toEqual([]);
    const rows = await stored(t);
    expect(rows).toHaveLength(200);
    expect(new Set(rows.map((r) => r.outbox_id)).size).toBe(200);
  });

  it("does not wait on rows another drainer is holding", async () => {
    const t = tag();
    await putOutbox(app.testDb, events(t, 200));
    const holder = new Client({ connectionString: app.config.databaseUrl });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query(`select id from "${app.testDb.outboxSchema}".audit_outbox order by id limit 50 for update`);
      const timedOut = Symbol("timed out");
      // The explicit return type keeps `typeof timedOut` from widening to plain `symbol` through
      // inference, so the `throw` below actually narrows `first` to `DrainResult` for tsc.
      const first = await Promise.race([drain(500), settle(2000).then((): typeof timedOut => timedOut)]);
      if (first === timedOut) throw new Error("a drain waited 2 s on rows another drainer holds instead of skipping them");
      expect(first.moved).toBe(150);
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
    expect((await drain(500)).moved).toBe(50);
    const rows = await stored(t);
    expect(rows).toHaveLength(200);
    expect(new Set(rows.map((r) => r.outbox_id)).size).toBe(200);
  });
});
