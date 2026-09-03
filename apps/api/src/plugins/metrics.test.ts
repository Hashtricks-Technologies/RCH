import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../app.js";
import { withTransaction } from "../lib/db.js";
import { allocateId, ensureSequences } from "../lib/ids.js";
import { buildTestApp } from "../test/app.js";

let app: App;
beforeAll(async () => {
  app = await buildTestApp({ schema: "metrics" });
  await app.ready();
  await withTransaction(app.db, (tx) => ensureSequences(tx));
});
afterAll(async () => { await app.close(); });

const scrape = async () => (await app.inject({ method: "GET", url: "/metrics" })).body;

describe("/metrics", () => {
  it("reports the connection pool, so an exhausted pool is visible before requests start timing out", async () => {
    const body = await scrape();
    expect(body).toContain("pg_pool_total");
    expect(body).toContain("pg_pool_idle");
    expect(body).toContain("pg_pool_waiting");
  });
  it("counts document numbers as they are handed out, by series", async () => {
    expect(await scrape()).not.toContain('sequence_allocations_total{kind="tkt"}');
    await withTransaction(app.db, (tx) => allocateId(tx, "tkt"));
    expect(await scrape()).toContain('sequence_allocations_total{kind="tkt"} 1');
  });
});
