import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Permissions, Role } from "@rch/contract";
import { DESK_DEFAULTS } from "@rch/domain";
import type { App } from "../app.js";
import { users } from "../db/schema/index.js";
import { authHeaders } from "./auth.js";

/**
 * Put a seeded account on a role of the test's own, on the account's own desk, holding `perms`.
 * The role is made through the super admin's route (u7), so the domain's grant rules still apply;
 * the account is moved by hand, because the account write's own rules are the admin suite's
 * business. Returns the undo: the account goes back to its desk's seeded role.
 */
export async function giveRole(app: App, userId: string, desk: Role, perms: Permissions): Promise<() => Promise<void>> {
  const r = await app.inject({
    method: "POST", url: "/api/v1/admin/roles",
    headers: { ...(await authHeaders(app, "u7")), "idempotency-key": randomUUID() },
    payload: { name: `Probe ${randomUUID().slice(0, 8)}`, desk, perms },
  });
  if (r.statusCode !== 200) throw new Error(`could not make the role: ${r.body}`);
  const [was] = await app.db.select({ roleId: users.roleId }).from(users).where(eq(users.id, userId));
  await app.db.update(users).set({ roleId: r.json().result.id as string }).where(eq(users.id, userId));
  app.access.clear();
  return async () => {
    await app.db.update(users).set({ roleId: was.roleId }).where(eq(users.id, userId));
    app.access.clear();
  };
}

/** The seeded role's permissions for a desk plus these extra grants - "a counter granted X". */
export const seededPlus = (desk: Role, f: Permissions["f"], a: Permissions["a"] = []): Permissions => {
  const base = DESK_DEFAULTS[desk].perms;
  return { f: { ...base.f, ...f }, a: [...base.a, ...a] };
};
