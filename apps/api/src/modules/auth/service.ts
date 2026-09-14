import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SignInEntry, User } from "@rch/contract";
import type { Db } from "../../db/client.js";
import type { Config } from "../../config.js";
import { withTransaction } from "../../lib/db.js";
import { RateLimitedError, RuleError, UnauthenticatedError } from "../../lib/errors.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { toWireUser } from "../../lib/wire.js";
import { authRepo } from "./repo.js";

export type Meta = { userAgent?: string; ip?: string };
export type Session = { user: User; mustChangePassword: boolean; refreshToken: string; expiresAt: Date; claims: { id: string; role: User["r"]; loc: User["loc"]; mcp: boolean; admin: boolean } };

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const newRaw = () => randomBytes(32).toString("base64url");
const BAD_LOGIN = "That employee id and password do not match.";
/** Any valid Argon2id string, produced once by `hashPassword("x")` - verified against on an
 *  unknown employee id so "no such user" takes about as long as "wrong password". */
const DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=1$LOmzJu8PWUsCPtFBwcH39w$RNwG8DhqDVFkCZWhCIv2DvxlqKkAP91CtOmSexvaOVk";
/** How many `begin()` calls between sweeps of keys whose window has gone quiet. */
const SWEEP_EVERY = 1000;

/**
 * Per-employee sliding window of sign-in attempts, in memory, and therefore per pod - as is the
 * per-IP limit beside it, which `@fastify/rate-limit` also keeps in this process's own memory.
 * Neither is cluster-wide: the load balancer spreads requests across replicas, so the effective
 * budget is the configured number multiplied by however many pods are running. That is accepted
 * rather than solved. If it ever has to be exact, the fix is a shared store (the rate limiter
 * takes a Redis-backed one), not a bigger number here.
 *
 * **Within a pod the budget holds under concurrency**, which is the whole reason an attempt is
 * recorded by `begin` before it is verified rather than after it fails. Argon2 takes 50–100 ms,
 * so a counter that only ever saw *settled* failures would let any number of simultaneous
 * guesses past a gate reading zero - and burn a core per guess doing it. An attempt costs its
 * slot from the instant it starts; `release` gives that one slot back if the password turns out
 * to be correct, so a correct password never contributes to the budget and a wrong one counts
 * immediately. `isLocked` and `begin` are both synchronous and are called back to back, so no
 * two requests can interleave between reading the budget and spending it.
 *
 * The key is an employee id off the wire, so the map is an attack surface of its own: without
 * a bound, a script posting a fresh `emp` every request grows it until the pod dies. Two
 * things keep it small - a key whose window has aged out is dropped instead of kept as an
 * empty array, and the map is capped, evicting the oldest key (Map preserves insertion order)
 * when a new one would push it past `cap`. Evicting the oldest can only ever forget attempts,
 * never invent them, and the schema caps `emp` at 64 characters so a key is cheap.
 */
export class Attempts {
  private m = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  private cap: number;
  private starts = 0;
  constructor(max: number, windowMs = 60_000, cap = 10_000) {
    this.max = max;
    this.windowMs = windowMs;
    this.cap = cap;
  }
  /** Has this employee id already spent its budget for the window? A pure read - nothing is
   *  recorded here, so merely naming an id costs the person who owns it nothing. */
  isLocked(key: string): boolean {
    const now = Date.now();
    return (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs).length >= this.max;
  }
  /** Records an attempt that is about to be verified, and answers the stamp `release` takes
   *  back. Spending the slot now rather than on failure is what makes the budget hold while
   *  several attempts on one id are in flight at once. */
  begin(key: string): number {
    const now = Date.now();
    if (++this.starts % SWEEP_EVERY === 0) this.sweep();
    const a = (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs);
    a.push(now);
    // Re-insert so the key moves to the back of the eviction order.
    this.m.delete(key);
    while (this.m.size >= this.cap) this.m.delete(this.m.keys().next().value as string);
    this.m.set(key, a);
    return now;
  }
  /** Gives back the one attempt `begin` recorded, for a sign-in that turned out to be correct.
   *  Exactly one entry, never the key: a wrong attempt in flight beside it keeps its own slot,
   *  so a success cannot launder somebody else's guesses. Two attempts inside the same
   *  millisecond carry the same stamp, and removing either of them is the same thing. */
  release(key: string, at: number): void {
    const a = this.m.get(key);
    if (!a) return;
    const i = a.indexOf(at);
    if (i >= 0) a.splice(i, 1);
    if (a.length === 0) this.m.delete(key);
  }
  /** Drops every key whose window has emptied. Called on a sweep, not on the hot path. */
  sweep(): void {
    const now = Date.now();
    for (const [k, a] of this.m) if (a.every((t) => now - t >= this.windowMs)) this.m.delete(k);
  }
  get size(): number {
    return this.m.size;
  }
}

export function createAuthService(db: Db, config: Config) {
  const attempts = new Attempts(config.loginRateLimitPerEmpPerMinute);
  const expiry = () => new Date(Date.now() + config.refreshTokenTtlDays * 86400_000);

  async function issue(tx: Parameters<Parameters<typeof withTransaction>[1]>[0], u: NonNullable<Awaited<ReturnType<typeof authRepo.userById>>>, family: string, meta: Meta, startedAt?: Date): Promise<Session> {
    const raw = newRaw();
    // A refresh family is only as long-lived as its first token: rotation resets the *idle*
    // clock (`expiry()`, from now) but must never push the family's absolute lifetime past 30
    // days from when it was first issued at login. A brand-new family (no rows yet) has no
    // earlier start to be capped by, so it gets the ordinary now+30d.
    const familyStartedAt = startedAt ?? (await authRepo.familyStartedAt(tx, family)) ?? new Date();
    const familyCap = new Date(familyStartedAt.getTime() + config.refreshTokenTtlDays * 86400_000);
    const expiresAt = new Date(Math.min(expiry().getTime(), familyCap.getTime()));
    await authRepo.insertRefresh(tx, { userId: u.id, family, tokenHash: sha256(raw), expiresAt, userAgent: meta.userAgent, ip: meta.ip });
    return { user: toWireUser(u), mustChangePassword: u.mustChangePassword, refreshToken: raw, expiresAt, claims: { id: u.id, role: u.role, loc: u.loc as User["loc"], mcp: u.mustChangePassword, admin: u.admin } };
  }

  return {
    /** The sign-in screen's employee picker - see `authRepo.signInDirectory` for who is on it. */
    async directory(): Promise<SignInEntry[]> {
      return authRepo.signInDirectory(db);
    },
    async login(emp: string, password: string, meta: Meta): Promise<Session> {
      // Read the budget, then spend a slot on this attempt - before the ~50–100 ms of Argon2
      // below, so simultaneous guesses at one employee id cannot all pass a gate that has not
      // seen any of them fail yet. The slot comes back only if the password was right, which is
      // what keeps a shift change from locking a till out: a correct sign-in leaves the budget
      // exactly where it found it.
      if (attempts.isLocked(emp)) throw new RateLimitedError("Too many attempts for that employee id - wait a minute and try again.");
      const attempt = attempts.begin(emp);
      const u = await authRepo.userByEmp(db, emp);
      const ok = u ? await verifyPassword(u.passwordHash, password) : (await verifyPassword(DUMMY_HASH, password), false);
      // One sentence for all three, so the wire gives nothing away; the cause is for the log
      // alone. An id that matched nobody is not written down - what was typed into that box
      // may well have been the password.
      if (!u) throw new UnauthenticatedError(BAD_LOGIN, "no such employee");
      if (!ok) throw new UnauthenticatedError(BAD_LOGIN, `wrong password for ${u.empNo}`);
      if (!u.active) throw new UnauthenticatedError(BAD_LOGIN, `${u.empNo} is deactivated`);
      attempts.release(emp, attempt);
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
        if (t.expiresAt < new Date()) return { ok: false as const, message: "Your session has expired - sign in again." };
        const u = await authRepo.userById(tx, t.userId);
        if (!u || !u.active) return { ok: false as const, message: "Your session has ended - sign in again." };
        // Claim the token atomically: UPDATE ... WHERE used_at IS NULL RETURNING id. This is
        // the only thing that decides who wins a race between two concurrent refreshes of the
        // same cookie - a plain "if (t.usedAt)" read-then-write would let both requests see
        // used_at = null and both proceed. Postgres serialises the two UPDATEs on the row: the
        // loser blocks, then re-reads used_at as already set and claims zero rows, which is
        // exactly the reuse case below.
        const claimed = await authRepo.markUsed(tx, t.id);
        if (claimed.length === 0) {
          await authRepo.revokeFamily(tx, t.family);
          return { ok: false as const, message: "Your session was used from somewhere else and has been closed - sign in again." };
        }
        // A family past its 30 days is dead even when this row's own expiry says otherwise (rows
        // minted before the absolute cap existed): refuse, rather than mint an already-expired token.
        const startedAt = await authRepo.familyStartedAt(tx, t.family);
        if (startedAt && startedAt.getTime() + config.refreshTokenTtlDays * 86400_000 <= Date.now()) return { ok: false as const, message: "Your session has expired - sign in again." };
        return { ok: true as const, session: await issue(tx, u, t.family, meta, startedAt) };
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
    /**
     * Changing the password hands back a whole new session, not an `{ ok: true }`. Every other
     * token the user holds is revoked - including the caller's own refresh cookie, and the
     * access token they authenticated this very request with, which still carries `mcp: true`
     * for the must-change case. Without a replacement the client would be left holding two dead
     * credentials: the access token is refused by `roleGate`, and the cookie that could renew it
     * has just been revoked. So the new family is minted inside the same transaction.
     */
    async changePassword(userId: string, current: string, next: string, meta: Meta): Promise<Session> {
      const u = await authRepo.userById(db, userId);
      // Verify (or dummy-verify, for timing parity with the active/found case) regardless of
      // whether the account is active, then gate on both together - same message either way,
      // so an inactive account and a wrong current password are indistinguishable to the caller.
      const ok = u ? await verifyPassword(u.passwordHash, current) : (await verifyPassword(DUMMY_HASH, current), false);
      if (!u || !ok || !u.active) throw new UnauthenticatedError("Your current password is not right.");
      if (next === current) throw new RuleError("Choose a different password from your current one.");
      const hash = await hashPassword(next);
      return withTransaction(db, async (tx) => {
        await authRepo.setPassword(tx, userId, hash);
        await authRepo.revokeAllForUser(tx, userId);
        // Re-read inside the transaction so the session is minted from the row as it now
        // stands - `must_change_password` cleared, so the fresh access token carries mcp: false.
        const fresh = await authRepo.userById(tx, userId);
        if (!fresh) throw new UnauthenticatedError("That account no longer exists.");
        return issue(tx, fresh, randomUUID(), meta);
      });
    },
  };
}
/** @public - consumed by Phase 2 write endpoints. */
export type AuthService = ReturnType<typeof createAuthService>;
