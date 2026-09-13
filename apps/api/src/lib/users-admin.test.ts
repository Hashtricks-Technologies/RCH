import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { createUser, deactivateUser, reactivateUser, resetPassword, setAdmin, updateUserRoleLoc } from "./users-admin.js";
import { verifyPassword } from "./password.js";
import { ConflictError, ValidationError } from "./errors.js";
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
  it("refuses a password weaker than the one the user could have chosen themselves", async () => {
    // MIN_PASSWORD_LENGTH (@rch/contract) is the same number ChangePasswordBodySchema enforces:
    // an administrator's temporary password must not be the weaker of the two doors in.
    await expect(createUser(t.db, { emp: "RC-9003", name: "X", email: "x@x", role: "counter", loc: "rest", password: "short-1" })).rejects.toThrow(/at least 10 characters/);
    await expect(resetPassword(t.db, "RC-4471", "short-1")).rejects.toThrow(/at least 10 characters/);
    // and nothing was written on the way to the refusal
    expect(await t.db.select().from(users).where(eq(users.empNo, "RC-9003"))).toHaveLength(0);
  });
  it("refuses a role at a location that role never works at", async () => {
    // Nothing downstream checks the pairing, so a Kitchen In-charge created at an outlet is an
    // account that can act where its role was never meant to reach.
    await expect(createUser(t.db, { emp: "RC-9004", name: "X", email: "x@x", role: "prod", loc: "coffee", password: "temporary-pass-1" })).rejects.toThrow("Kitchen In-charge works at kitchen, not at coffee");
    await expect(createUser(t.db, { emp: "RC-9005", name: "X", email: "x@x", role: "buyer", loc: "kiosk", password: "temporary-pass-1" })).rejects.toThrow("Procurement Officer works at store, not at kiosk");
    await expect(createUser(t.db, { emp: "RC-9006", name: "X", email: "x@x", role: "manager", loc: "store", password: "temporary-pass-1" })).rejects.toThrow("Outlet Manager works at rest or coffee or kiosk, not at store");
    // The pairings that are right are still accepted.
    const { id } = await createUser(t.db, { emp: "RC-9007", name: "Mani S", email: "mani.s@royalcare.in", role: "prod", loc: "kitchen", password: "temporary-pass-1" });
    const [u] = await t.db.select().from(users).where(eq(users.id, id));
    expect(u.loc).toBe("kitchen"); expect(u.roleLabel).toBe("Kitchen In-charge");
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

  it("every refusal is a proper AppError, not a bare Error — the right status for an HTTP caller", async () => {
    await expect(createUser(t.db, { emp: "RC-4471", name: "X", email: "x@x", role: "counter", loc: "rest", password: "temporary-pass-1" })).rejects.toThrow(ConflictError);
    await expect(createUser(t.db, { emp: "RC-9010", name: "X", email: "x@x", role: "counter", loc: "attic" as never, password: "temporary-pass-1" })).rejects.toThrow(ValidationError);
    await expect(createUser(t.db, { emp: "RC-9011", name: "X", email: "x@x", role: "prod", loc: "coffee", password: "temporary-pass-1" })).rejects.toThrow(ValidationError);
    await expect(createUser(t.db, { emp: "RC-9012", name: "X", email: "x@x", role: "counter", loc: "rest", password: "short-1" })).rejects.toThrow(ValidationError);
  });

  it("reactivate reverses a deactivate", async () => {
    await deactivateUser(t.db, "RC-1550");
    await reactivateUser(t.db, "RC-1550");
    const [u] = await t.db.select().from(users).where(eq(users.empNo, "RC-1550"));
    expect(u.active).toBe(true);
  });
  it("reactivate refuses an unknown employee number", async () => {
    await expect(reactivateUser(t.db, "RC-0000")).rejects.toThrow(ValidationError);
  });

  it("updateUserRoleLoc changes both together, validates the pairing, and revokes sessions", async () => {
    await t.db.insert(refreshTokens).values({ userId: "u2", family: "00000000-0000-4000-8000-000000000002", tokenHash: "h2", expiresAt: new Date(Date.now() + 1000) });
    await updateUserRoleLoc(t.db, "RC-3120", { role: "counter", loc: "kiosk" });
    const [u] = await t.db.select().from(users).where(eq(users.id, "u2"));
    expect(u.role).toBe("counter"); expect(u.loc).toBe("kiosk"); expect(u.roleLabel).toBe("Counter Operator");
    expect((await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, "u2"))).every((r: { revokedAt: Date | null }) => r.revokedAt)).toBe(true);
  });
  it("updateUserRoleLoc refuses a pairing that role never works at", async () => {
    await expect(updateUserRoleLoc(t.db, "RC-3120", { role: "prod", loc: "coffee" })).rejects.toThrow(/Kitchen In-charge works at kitchen/);
  });
  it("updateUserRoleLoc refuses an unknown employee number", async () => {
    await expect(updateUserRoleLoc(t.db, "RC-0000", { role: "counter", loc: "rest" })).rejects.toThrow(ValidationError);
  });
});

describe("setAdmin", () => {
  it("flips the flag on and off, and refuses an unknown employee number", async () => {
    await setAdmin(t.db, "RC-1902", true);
    expect((await t.db.select().from(users).where(eq(users.empNo, "RC-1902")))[0].admin).toBe(true);
    await setAdmin(t.db, "RC-1902", false);
    expect((await t.db.select().from(users).where(eq(users.empNo, "RC-1902")))[0].admin).toBe(false);
    await expect(setAdmin(t.db, "RC-0000", true)).rejects.toThrow(ValidationError);
  });
});
