import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { createUser, deactivateUser, resetPassword } from "./users-admin.js";
import { verifyPassword } from "./password.js";
import { refreshTokens, users } from "../db/schema/index.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("users_admin"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

describe("users-admin", () => {
  it("creates a user who must change their password, with the next id in the series", async () => {
    const { id } = await createUser(t.db, { emp: "RC-9001", name: "Anitha R", email: "anitha.r@royalcare.in", role: "counter", loc: "rest", password: "temporary-pass-1" });
    expect(id).toBe("u7");
    const [u] = await t.db.select().from(users).where(eq(users.id, id));
    expect(u.mustChangePassword).toBe(true); expect(u.roleLabel).toBe("Counter Operator"); expect(await verifyPassword(u.passwordHash, "temporary-pass-1")).toBe(true);
  });
  it("refuses a duplicate employee number and an unknown location", async () => {
    await expect(createUser(t.db, { emp: "RC-4471", name: "X", email: "x@x", role: "counter", loc: "rest", password: "temporary-pass-1" })).rejects.toThrow(/RC-4471/);
    await expect(createUser(t.db, { emp: "RC-9002", name: "X", email: "x@x", role: "counter", loc: "attic" as never, password: "temporary-pass-1" })).rejects.toThrow(/location/);
  });
  it("reset-password sets a temporary password and revokes sessions", async () => {
    await t.db.insert(refreshTokens).values({ userId: "u1", family: "00000000-0000-4000-8000-000000000001", tokenHash: "h", expiresAt: new Date(Date.now() + 1000) });
    await resetPassword(t.db, "RC-4471", "another-temp-pass");
    const [u] = await t.db.select().from(users).where(eq(users.id, "u1"));
    expect(u.mustChangePassword).toBe(true); expect(await verifyPassword(u.passwordHash, "another-temp-pass")).toBe(true);
    expect((await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, "u1"))).every((r: { revokedAt: Date | null }) => r.revokedAt)).toBe(true);
  });
  it("deactivate flips active and revokes sessions", async () => {
    await deactivateUser(t.db, "RC-4482");
    const [u] = await t.db.select().from(users).where(eq(users.id, "u6"));
    expect(u.active).toBe(false);
  });
  it("reset-password refuses an unknown employee number", async () => {
    await expect(resetPassword(t.db, "RC-0000", "another-temp-pass")).rejects.toThrow(/RC-0000/);
  });
  it("deactivate refuses an unknown employee number", async () => {
    await expect(deactivateUser(t.db, "RC-0000")).rejects.toThrow(/RC-0000/);
  });
});
