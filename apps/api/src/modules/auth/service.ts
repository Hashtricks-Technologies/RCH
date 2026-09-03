import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { User } from "@rch/contract";
import type { Db } from "../../db/client.js";
import type { Config } from "../../config.js";
import { withTransaction } from "../../lib/db.js";
import { RateLimitedError, UnauthenticatedError } from "../../lib/errors.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { toWireUser } from "../../lib/wire.js";
import { authRepo } from "./repo.js";

export type Meta = { userAgent?: string; ip?: string };
export type Session = { user: User; mustChangePassword: boolean; refreshToken: string; claims: { id: string; role: User["r"]; loc: User["loc"]; mcp: boolean } };

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const newRaw = () => randomBytes(32).toString("base64url");
const BAD_LOGIN = "That employee id and password do not match.";
/** Any valid Argon2id string, produced once by `hashPassword("x")` — verified against on an
 *  unknown employee id so "no such user" takes about as long as "wrong password". */
const DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=1$LOmzJu8PWUsCPtFBwcH39w$RNwG8DhqDVFkCZWhCIv2DvxlqKkAP91CtOmSexvaOVk";

/** Per-employee sliding window, in memory. Per pod, which is fine: the per-IP limit is cluster-wide via the LB. */
class Attempts {
  private m = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  hit(key: string): boolean {
    const now = Date.now();
    const a = (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs);
    a.push(now);
    this.m.set(key, a);
    return a.length > this.max;
  }
  clear(key: string) {
    this.m.delete(key);
  }
}

export function createAuthService(db: Db, config: Config) {
  const attempts = new Attempts(Math.max(1, Math.floor(config.loginRateLimitPerMinute / 2)));
  const expiry = () => new Date(Date.now() + config.refreshTokenTtlDays * 86400_000);

  async function issue(tx: Parameters<Parameters<typeof withTransaction>[1]>[0], u: NonNullable<Awaited<ReturnType<typeof authRepo.userById>>>, family: string, meta: Meta): Promise<Session> {
    const raw = newRaw();
    await authRepo.insertRefresh(tx, { userId: u.id, family, tokenHash: sha256(raw), expiresAt: expiry(), userAgent: meta.userAgent, ip: meta.ip });
    return { user: toWireUser(u), mustChangePassword: u.mustChangePassword, refreshToken: raw, claims: { id: u.id, role: u.role, loc: u.loc as User["loc"], mcp: u.mustChangePassword } };
  }

  return {
    async login(emp: string, password: string, meta: Meta): Promise<Session> {
      if (attempts.hit(emp)) throw new RateLimitedError("Too many attempts for that employee id - wait a minute and try again.");
      const u = await authRepo.userByEmp(db, emp);
      const ok = u ? await verifyPassword(u.passwordHash, password) : (await verifyPassword(DUMMY_HASH, password), false);
      if (!u || !ok || !u.active) throw new UnauthenticatedError(BAD_LOGIN);
      attempts.clear(emp);
      return withTransaction(db, (tx) => issue(tx, u, randomUUID(), meta));
    },
    async refresh(raw: string | undefined, meta: Meta): Promise<Session> {
      if (!raw) throw new UnauthenticatedError("Your session has ended - sign in again.");
      // Reuse detection must revoke the family *and have that revoke survive* even though the
      // request itself fails: throwing inside withTransaction rolls the whole transaction back
      // (Drizzle wraps the callback in BEGIN/COMMIT-or-ROLLBACK), which would undo the revoke
      // along with the error. So every branch returns instead of throwing, and the one throw
      // happens after the transaction has committed.
      const outcome = await withTransaction(db, async (tx) => {
        const t = await authRepo.refreshByHash(tx, sha256(raw));
        if (!t || t.revokedAt) return { ok: false as const, message: "Your session has ended - sign in again." };
        if (t.usedAt) {
          await authRepo.revokeFamily(tx, t.family);
          return { ok: false as const, message: "Your session was used from somewhere else and has been closed - sign in again." };
        }
        if (t.expiresAt < new Date()) return { ok: false as const, message: "Your session has expired - sign in again." };
        const u = await authRepo.userById(tx, t.userId);
        if (!u || !u.active) return { ok: false as const, message: "Your session has ended - sign in again." };
        await authRepo.markUsed(tx, t.id);
        return { ok: true as const, session: await issue(tx, u, t.family, meta) };
      });
      if (!outcome.ok) throw new UnauthenticatedError(outcome.message);
      return outcome.session;
    },
    async logout(raw: string | undefined): Promise<void> {
      if (!raw) return;
      await withTransaction(db, async (tx) => {
        const t = await authRepo.refreshByHash(tx, sha256(raw));
        if (t) await authRepo.revokeFamily(tx, t.family);
      });
    },
    async changePassword(userId: string, current: string, next: string): Promise<void> {
      const u = await authRepo.userById(db, userId);
      if (!u || !(await verifyPassword(u.passwordHash, current))) throw new UnauthenticatedError("Your current password is not right.");
      const hash = await hashPassword(next);
      await withTransaction(db, async (tx) => {
        await authRepo.setPassword(tx, userId, hash);
        await authRepo.revokeAllForUser(tx, userId);
      });
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
