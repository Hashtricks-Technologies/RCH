import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { payers } from "../db/schema/index.js";
import { importPayers, parsePayerCsv } from "./payers-admin.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("payers_admin"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

const nameOf = async (kind: "patient" | "staff" | "dept", id: string): Promise<string | undefined> => {
  const [row] = await t.db.select().from(payers).where(and(eq(payers.kind, kind), eq(payers.id, id)));
  return row?.name;
};

describe("parsePayerCsv", () => {
  it("parses a CSV, names the row and the column on a bad kind", () => {
    const { rows, errors } = parsePayerCsv([
      "kind,id,name",
      "patient,IP-8001,Anand Kumar · Ward 3B",
      "patinet,IP-8002,Meera Devi · Ward 2A",
      'dept,CC-PHY,"Physiotherapy, East Wing"',
      "",
      "# a comment line the loader skips",
      "staff,,Nameless Number",
    ].join("\n"));

    // The good rows come through whole, quoted commas and all.
    expect(rows).toEqual([
      { kind: "patient", id: "IP-8001", name: "Anand Kumar · Ward 3B" },
      { kind: "dept", id: "CC-PHY", name: "Physiotherapy, East Wing" },
    ]);
    // And every bad one is named by the line an editor shows and the column that is wrong,
    // so one run tells the administrator everything to fix.
    expect(errors).toEqual([
      { row: 3, column: "kind", message: '"patinet" is not a payer kind — use one of patient, staff, dept' },
      { row: 7, column: "id", message: "an id is required — it is the hospital's own number, not one this tool invents" },
    ]);
  });
});

describe("importPayers", () => {
  it("skips an id already on the roster and reports it", async () => {
    // RC-4471 is seeded (Kavitha Raman · F&B). A re-run of the same payroll export must not
    // quietly rename people, so it is skipped and counted rather than overwritten.
    const first = await importPayers(t.db, [
      { kind: "staff", id: "RC-4471", name: "Kavitha R (payroll export)" },
      { kind: "staff", id: "E8100", name: "Brand New" },
    ], { replaceNames: false });
    expect(first).toEqual({ added: 1, skipped: 1, renamed: 0 });
    expect(await nameOf("staff", "RC-4471")).toBe("Kavitha Raman · F&B");
    expect(await nameOf("staff", "E8100")).toBe("Brand New");

    // Run the very same file again: nothing new, nothing touched.
    expect(await importPayers(t.db, [{ kind: "staff", id: "E8100", name: "Brand New" }], {}))
      .toEqual({ added: 0, skipped: 1, renamed: 0 });
  });

  it("renames only with --replace-names", async () => {
    await importPayers(t.db, [{ kind: "patient", id: "IP-8200", name: "Ward 1" }], {});
    expect(await importPayers(t.db, [{ kind: "patient", id: "IP-8200", name: "Ward 2" }], {}))
      .toEqual({ added: 0, skipped: 1, renamed: 0 });
    expect(await nameOf("patient", "IP-8200")).toBe("Ward 1");

    expect(await importPayers(t.db, [{ kind: "patient", id: "IP-8200", name: "Ward 2" }], { replaceNames: true }))
      .toEqual({ added: 0, skipped: 0, renamed: 1 });
    expect(await nameOf("patient", "IP-8200")).toBe("Ward 2");

    // "renamed" means renamed, not "touched": a row whose name already matches is a skip.
    expect(await importPayers(t.db, [{ kind: "patient", id: "IP-8200", name: "Ward 2" }], { replaceNames: true }))
      .toEqual({ added: 0, skipped: 1, renamed: 0 });
  });

  it("aborts the whole file on one bad row", async () => {
    // One transaction, so half a ward list can never land: the good row before the bad one is
    // rolled back with it, and the administrator fixes the file and runs it again.
    await expect(importPayers(t.db, [
      { kind: "dept", id: "CC-GOOD", name: "Would have landed" },
      { kind: "dept", id: "CC-BAD", name: "   " },
      { kind: "dept", id: "CC-AFTER", name: "Never reached" },
    ], {})).rejects.toThrow('row 2, column "name": a name is required');
    expect(await nameOf("dept", "CC-GOOD")).toBeUndefined();
    expect(await nameOf("dept", "CC-AFTER")).toBeUndefined();
  });
});
