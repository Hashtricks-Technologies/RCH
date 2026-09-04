import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { truncateAll } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "support" }); await app.ready(); });
// `buildTestApp` migrates but does NOT seed, and `authHeaders` throws
// `no user u1 - did you seed?` without this. Copy the shape from
// `modules/tickets/tickets.test.ts:15-17`; every DB-backed module suite has it.
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });
afterAll(async () => { await app.close(); });

const list = async (userId: string) => {
  const res = await app.inject({ method: "GET", url: "/api/v1/support/tickets", headers: await authHeaders(app, userId) });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; by: string }[];
};

describe("GET /support/tickets", () => {
  it("answers with the caller's own tickets and nobody else's, in every role", async () => {
    const mine = await given.supportTicket(app.db, { by: "u1", subject: "Mine" });
    const theirs = await given.supportTicket(app.db, { by: "u3", subject: "Theirs" });

    const asCounter = await list("u1");
    expect(asCounter.map((t) => t.id)).toContain(mine);
    expect(asCounter.map((t) => t.id)).not.toContain(theirs);

    // The store keeper is not a support agent either: own tickets, same as everyone.
    const asStore = await list("u3");
    expect(asStore.map((t) => t.id)).toContain(theirs);
    expect(asStore.map((t) => t.id)).not.toContain(mine);
  });

  it("is open to every role — support is the one module all five share (§8.3)", async () => {
    for (const u of ["u1", "u2", "u3", "u4", "u5"]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/support/tickets", headers: await authHeaders(app, u) });
      expect(res.statusCode).toBe(200);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/support/tickets" });
    expect(res.statusCode).toBe(401);
  });
});
