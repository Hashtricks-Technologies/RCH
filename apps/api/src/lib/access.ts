import { eq } from "drizzle-orm";
import type { Permissions, Role } from "@rch/contract";
import { roles, users } from "../db/schema/index.js";
import type { Reader } from "./db.js";

/**
 * What an account may do right now: its role, that role's desk and permissions, and whether the
 * role is still active. Read per request (through the cache below), never from the token - so a
 * change the super admin makes to a role reaches the very next request of everyone holding it.
 */
export type RoleAccess = { roleId: string; desk: Role; perms: Permissions; active: boolean };

/** How long an entry stands without a `roles` notice. The notice is what makes a change take
 *  effect at once; this bounds how stale a pod can be if one is ever missed. */
const ACCESS_TTL_MS = 60_000;

/** The account's role, joined in one primary-key read. `null` for an account that is gone and
 *  for a super admin, which holds no role. */
export async function loadAccess(db: Reader, userId: string): Promise<RoleAccess | null> {
  const [row] = await db.select({ roleId: roles.id, desk: roles.desk, perms: roles.perms, active: roles.active })
    .from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.id, userId));
  return row ? { roleId: row.roleId, desk: row.desk, perms: row.perms as Permissions, active: row.active } : null;
}

export type AccessCache = {
  of(userId: string): Promise<RoleAccess | null>;
  /** Forget everything, and make any read already in flight forget what it is about to store. */
  clear(): void;
};

/**
 * A per-pod cache of `loadAccess`, keyed by user.
 *
 * `clear()` bumps a generation counter as well as emptying the map. A read that started before
 * the clear may come back after it holding the role as it stood before the change; it answers its
 * own request with that (the request raced the change, and either order was possible), but it does
 * not store it, so the next request reads again.
 */
export function createAccessCache(load: (userId: string) => Promise<RoleAccess | null>, opts: { ttlMs?: number; now?: () => number } = {}): AccessCache {
  const ttl = opts.ttlMs ?? ACCESS_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { at: number; value: RoleAccess | null }>();
  let generation = 0;
  return {
    async of(userId) {
      const hit = entries.get(userId);
      if (hit && now() - hit.at < ttl) return hit.value;
      const started = generation;
      const value = await load(userId);
      if (started === generation) entries.set(userId, { at: now(), value });
      return value;
    },
    clear() {
      generation++;
      entries.clear();
    },
  };
}
