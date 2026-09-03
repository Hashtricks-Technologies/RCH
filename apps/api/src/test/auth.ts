import { eq } from "drizzle-orm";
import type { App } from "../app.js";
import { users } from "../db/schema/index.js";

/** A bearer header for a seeded user, minted directly — tests of non-auth modules need not run the login flow. */
export async function authHeaders(app: App, userId: string): Promise<{ authorization: string }> {
  const [u] = await app.db.select().from(users).where(eq(users.id, userId));
  if (!u) throw new Error(`no user ${userId} - did you seed?`);
  const token = await app.signAccess({ id: u.id, role: u.role, loc: u.loc as never, mcp: u.mustChangePassword });
  return { authorization: `Bearer ${token}` };
}
