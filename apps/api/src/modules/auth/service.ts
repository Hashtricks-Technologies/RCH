import { createHash, randomBytes, randomUUID } from "node:crypto";
import { STORE, type LocKey, type SignInEntry, type SwitchSideBody, type User } from "@rch/contract";
import { SIDE_DESK, standsAt } from "@rch/domain";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import type { Config } from "../../config.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError, RateLimitedError, RuleError, UnauthenticatedError } from "../../lib/errors.js";
import { assertOpen, lockLocation } from "../../lib/locations.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { endShift, startShift } from "../../lib/shifts.js";
import { assertRule } from "../../lib/rules.js";
import { placeOf, postingsOf, wireUserAt, type Place } from "../../lib/standing.js";
import { toWireLocation, type UserRow } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { loadAccess } from "../../lib/access.js";
import { authRepo } from "./repo.js";

export type Meta = { userAgent?: string; ip?: string };
/**
 * Who the caller is, where this session is standing, and every counter it may stand at.
 *
 * `postings` is *may work at*; `claims.loc` is *working at right now*, and it stays exactly one
 * location, which is why nothing else on the server had to learn about any of this. `user.loc`
 * carries the same one location as the claim rather than the home row's - for a consultant
 * halfway through a shift at somebody else's till those are two different places, and the screen
 * has to name the one they are standing at.
 */
export type Standing = { user: User; mustChangePassword: boolean; postings: LocKey[]; claims: { id: string; role: User["r"]; loc: User["loc"]; mcp: boolean; admin: boolean; unplaced: boolean } };
/** A standing that also opened a refresh family: a sign-in, a rotation or a password change. */
export type Session = Standing & { refreshToken: string; expiresAt: Date };

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const newRaw = () => randomBytes(32).toString("base64url");
const BAD_LOGIN = "That employee id and password do not match.";

/**
 * A refused sign-in - an unknown id, a wrong password or a deactivated account. The caller reads
 * one sentence whichever it was (`BAD_LOGIN`); the reason (`cause`) goes onto the request's log
 * line, and the account the id named, when it named one, goes into the audit trail
 * (`modules/auth/routes.ts`). Neither reaches the wire: `toEnvelope()` carries only code and
 * message.
 */
export class LoginRefused extends UnauthenticatedError {
  readonly userId: string | null;
  constructor(cause: string, userId: string | null) {
    super(BAD_LOGIN, cause);
    this.userId = userId;
  }
}

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

  /** Who the caller is and where this session is standing, off the account row and the postings
   *  table. `at` is the session's place, not the account's home. */
  async function standing(tx: Tx, u: UserRow, at: Place): Promise<Standing> {
    return {
      user: await wireUserAt(tx, u, { role: at.desk, loc: at.loc, unplaced: at.unplaced }),
      mustChangePassword: u.mustChangePassword,
      postings: await postingsOf(tx, u.id),
      claims: { id: u.id, role: at.desk, loc: at.loc, mcp: u.mustChangePassword, admin: u.admin, unplaced: at.unplaced },
    };
  }

  /**
   * May this account stand at this counter? The gate for a sign-in that names one and for a two-sided
   * session choosing one: the outlet row `FOR SHARE` first (documents tier, so it cannot be closed
   * out from under the answer), then the posting - or, for a two-sided role that works for every
   * outlet, any outlet at all (`standsAt`) - then open. Answers the outlet's name.
   */
  async function admitTo(tx: Tx, u: UserRow, loc: LocKey): Promise<string> {
    const row = await lockLocation(tx, loc);
    const postings = await postingsOf(tx, u.id);
    const access = await loadAccess(tx, u.id);
    // As if it were open: a closed outlet is refused in its own words, below.
    const anywhere = access ? standsAt(access, [], { [loc]: { ...toWireLocation(row), active: true } }).includes(loc) : false;
    assertRule(anywhere || postings.includes(loc), `You are not posted to ${row.name}.`);
    assertOpen(row, `nothing may be sold there`);
    return row.name;
  }

  /** `at` is where the new session stands. It is written onto the refresh row as well as into the
   *  claim: a silent refresh that re-read the home row would walk a consultant back to their own
   *  till in the middle of somebody else's shift. */
  async function issue(tx: Tx, u: UserRow, family: string, meta: Meta, at: Place, startedAt?: Date): Promise<Session> {
    const raw = newRaw();
    // A refresh family is only as long-lived as its first token: rotation resets the *idle*
    // clock (`expiry()`, from now) but must never push the family's absolute lifetime past 30
    // days from when it was first issued at login. A brand-new family (no rows yet) has no
    // earlier start to be capped by, so it gets the ordinary now+30d.
    const familyStartedAt = startedAt ?? (await authRepo.familyStartedAt(tx, family)) ?? new Date();
    const familyCap = new Date(familyStartedAt.getTime() + config.refreshTokenTtlDays * 86400_000);
    const expiresAt = new Date(Math.min(expiry().getTime(), familyCap.getTime()));
    await authRepo.insertRefresh(tx, { userId: u.id, family, tokenHash: sha256(raw), expiresAt, userAgent: meta.userAgent, ip: meta.ip, loc: at.loc, desk: at.unplaced ? null : at.desk });
    return { ...(await standing(tx, u, at)), refreshToken: raw, expiresAt };
  }

  return {
    /** The sign-in screen's employee picker - see `authRepo.signInDirectory` for who is on it. */
    async directory(): Promise<SignInEntry[]> {
      return authRepo.signInDirectory(db);
    },
    async login(emp: string, password: string, meta: Meta, loc?: LocKey): Promise<Session> {
      // Read the budget, then spend a slot on this attempt - before the ~50–100 ms of Argon2
      // below, so simultaneous guesses at one employee id cannot all pass a gate that has not
      // seen any of them fail yet. The slot comes back only if the password was right, which is
      // what keeps a shift change from locking a till out: a correct sign-in leaves the budget
      // exactly where it found it.
      if (attempts.isLocked(emp)) throw new RateLimitedError("Too many attempts for that employee id - wait a minute and try again.");
      const attempt = attempts.begin(emp);
      // A system account (`lib/system-users.ts`) is nobody to sign in as: it reads exactly as a
      // number nobody holds - the dummy hash, the one sentence and the same audit event - so the
      // sign-in screen cannot even tell it exists.
      const found = await authRepo.userByEmp(db, emp);
      const u = found?.system ? undefined : found;
      const ok = u ? await verifyPassword(u.passwordHash, password) : (await verifyPassword(DUMMY_HASH, password), false);
      // One sentence for all three, so the wire gives nothing away; the cause is for the log
      // alone. An id that matched nobody is not written down - what was typed into that box
      // may well have been the password.
      if (!u) throw new LoginRefused("no such employee", null);
      if (!ok) throw new LoginRefused(`wrong password for ${u.empNo}`, u.id);
      if (!u.active) throw new LoginRefused(`${u.empNo} is deactivated`, u.id);
      attempts.release(emp, attempt);
      // The counter the screen asked for, checked the same way a mid-shift move is. Refusing here
      // rather than signing them in and moving them afterwards keeps a session from ever existing
      // at a counter its own account is not posted to.
      return withTransaction(db, async (tx) => {
        if (loc) await admitTo(tx, u, loc);
        const at: Place = loc ? { desk: u.role, loc, unplaced: false } : await placeOf(tx, u, null);
        const session = await issue(tx, u, randomUUID(), meta, at);
        // A counter operator's shift starts with the sign-in at their counter (`lib/shifts.ts`).
        // A refresh does not come through here, so it never opens one; nor does a two-sided session
        // that has yet to choose a side, which opens one when it chooses a till.
        if (u.role === "counter" && !u.admin && !at.unplaced) await startShift(tx, u.id, session.claims.loc);
        return session;
      });
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
        // The rotated token stands where the session it replaces stood, as the claim above found it.
        // `loc` is null for every session opened before postings existed, and for those the home
        // row is where it was all along - which is exactly what the claim carried then too.
        return { ok: true as const, session: await issue(tx, u, t.family, meta, await placeOf(tx, u, claimed[0]), startedAt) };
      });
      if (!outcome.ok) throw new UnauthenticatedError(outcome.message);
      return outcome.session;
    },
    /**
     * A two-sided role choosing where it works - after the password, and on every later switch.
     *
     * The token still names one desk and one location; what changes is which. So this mints a fresh
     * access token and moves the refresh row with it, and rotates nothing: the cookie the caller
     * holds is the same session, now standing somewhere else. The row is locked first, so a
     * rotation racing it either waits and carries the new place forward or has already used the row,
     * and then the caller is told to refresh (a 401) and tries again with the cookie that replaced it.
     *
     * An account with one place to work has nothing to choose: the route does not exist for it.
     * Everybody else's counter is still fixed at sign-in.
     *
     * Moving to a till starts (or keeps) the shift there, closing one left open at another; moving to
     * the central store closes it. Answers the sentence the audit trail keeps.
     */
    async switchSide(userId: string, raw: string | undefined, body: SwitchSideBody): Promise<Standing & { message: string }> {
      return withTransaction(db, async (tx) => {
        const t = raw ? await authRepo.refreshForUpdate(tx, sha256(raw)) : undefined;
        if (!t || t.userId !== userId || t.usedAt || t.revokedAt || t.expiresAt < new Date()) throw new UnauthenticatedError("Your session has ended - sign in again.");
        const u = await authRepo.userById(tx, userId);
        if (!u || !u.active) throw new UnauthenticatedError("Your session has ended - sign in again.");
        if (!(await loadAccess(tx, userId))?.inventory) throw new NotFoundError("There is nothing to switch to: your role works in one place.");
        let at: Place;
        let message: string;
        if (body.side === "billing") {
          message = `Working Billing at ${await admitTo(tx, u, body.loc)}`;
          at = { desk: SIDE_DESK.billing, loc: body.loc, unplaced: false };
        } else {
          message = "Working Inventory at the Central Store";
          at = { desk: SIDE_DESK.inventory, loc: STORE, unplaced: false };
        }
        await authRepo.setStanding(tx, t.id, at);
        if (body.side === "billing") await startShift(tx, userId, body.loc);
        else await endShift(tx, userId);
        return { ...(await standing(tx, u, at)), message };
      });
    },
    /** Answers whose session this ended - the account, when the cookie's family still had a live
     *  token to revoke; `null` when it ended nothing (no cookie, an unknown one, or a family already
     *  revoked), which is not a sign-out anybody made. */
    async logout(raw: string | undefined): Promise<string | null> {
      if (!raw) return null;
      return withTransaction(db, async (tx) => {
        const t = await authRepo.refreshByHash(tx, sha256(raw));
        if (!t) return null;
        const revoked = await authRepo.revokeFamily(tx, t.family);
        return (revoked.rowCount ?? 0) > 0 ? t.userId : null;
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
    async changePassword(claims: AccessClaims, current: string, next: string, meta: Meta): Promise<Session> {
      const userId = claims.sub;
      const u = await authRepo.userById(db, userId);
      // Verify (or dummy-verify, for timing parity with the active/found case) regardless of
      // whether the account is active, then gate on both together - same message either way,
      // so an inactive account and a wrong current password are indistinguishable to the caller.
      const ok = u ? await verifyPassword(u.passwordHash, current) : (await verifyPassword(DUMMY_HASH, current), false);
      // One sentence for all three, as at sign-in; the cause is for the log line and the audit trail.
      if (!u || !ok || !u.active) {
        throw new UnauthenticatedError("Your current password is not right.", !u ? "no such account" : !ok ? "wrong current password" : `${u.empNo} is deactivated`);
      }
      if (next === current) throw new RuleError("Choose a different password from your current one.");
      const hash = await hashPassword(next);
      return withTransaction(db, async (tx) => {
        await authRepo.setPassword(tx, userId, hash);
        await authRepo.revokeAllForUser(tx, userId);
        // Re-read inside the transaction so the session is minted from the row as it now
        // stands - `must_change_password` cleared, so the fresh access token carries mcp: false.
        const fresh = await authRepo.userById(tx, userId);
        if (!fresh) throw new UnauthenticatedError("That account no longer exists.");
        // Where they were standing: a password changed mid-shift must not move anybody home.
        return issue(tx, fresh, randomUUID(), meta, await placeOf(tx, fresh, claims.unplaced ? null : { desk: claims.role, loc: claims.loc }));
      });
    },
  };
}
/** @public - consumed by Phase 2 write endpoints. */
export type AuthService = ReturnType<typeof createAuthService>;
