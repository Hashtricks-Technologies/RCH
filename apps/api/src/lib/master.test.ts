import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as FX from "@rch/contract/fixtures";
import { items } from "../db/schema/index.js";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { withTransaction } from "./db.js";
import { loadMaster } from "./master.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("master_loader"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

describe("loadMaster", () => {
  it("returns the seeded item master, unchanged", async () => {
    expect((await loadMaster(t.db)).items).toEqual(FX.IT);
  });
  it("returns every location, quarantine included — the rules ignore it, they do not need it hidden", async () => {
    const m = await loadMaster(t.db);
    expect(m.locations).toEqual(FX.LOC);
    expect(m.locations.quarantine).toMatchObject({ n: "Quarantine", type: "Store" });
  });
  it("returns the recipes with their lines in the order they were written", async () => {
    expect((await loadMaster(t.db)).recipes).toEqual(FX.RCP);
  });
  it("leaves a withdrawn item out, so no rule can price something the master no longer sells", async () => {
    await t.db.update(items).set({ active: false }).where(eq(items.key, "chips"));
    try {
      expect((await loadMaster(t.db)).items.chips).toBeUndefined();
    } finally {
      await t.db.update(items).set({ active: true }).where(eq(items.key, "chips"));
    }
    expect((await loadMaster(t.db)).items.chips).toEqual(FX.IT.chips);
  });
  it("reads through a caller's transaction, so a service sees its own writes", async () => {
    const m = await withTransaction(t.db, (tx) => loadMaster(tx));
    expect(Object.keys(m.items).length).toBe(Object.keys(FX.IT).length);
  });
});
