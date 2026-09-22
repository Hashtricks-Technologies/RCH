import { z } from "zod";
import { UserSchema } from "./documents.js";
import { LocKeySchema } from "./common.js";

/** Request bodies are strict: an unknown key is a client bug (a renamed field, a stale build),
 *  and silently dropping it hides the mistake until someone wonders why the value never saved. */
export const LoginBodySchema = z.strictObject({
  emp: z.string().trim().min(1).max(64), password: z.string().min(1).max(200),
  /** The counter being signed in to, for an account posted to more than one. The sign-in screen
   *  asks which before the password, so the operator arrives already standing where they meant
   *  to be rather than at a home counter they then have to move off. Omitted - the ordinary case
   *  - the claim is minted from the account's home location, exactly as it always was. */
  loc: LocKeySchema.optional(),
});
/** One line of the sign-in screen's employee picker: the number, the name, and the counters the
 *  account works. The list is public - it is read before anybody has signed in - so it carries no
 *  role, email or phone, and never an admin-flagged or deactivated account. The counters are on it
 *  because the screen asks which one before the password, and that question cannot wait for a
 *  token; it is the same roster the outlet prints on its own wall. */
/** One counter on the sign-in screen: the key the wire uses, and the name and code the operator
 *  reads off the outlet itself. */
export const SignInCounterSchema = z.strictObject({ k: LocKeySchema, n: z.string(), c: z.string() });
export const SignInEntrySchema = z.strictObject({
  emp: z.string(), n: z.string(),
  /** Every counter this account works, each carrying its own printed name and code.
   *
   *  The name travels because nothing on the sign-in screen can look one up: `data/master.ts`'s
   *  registries are filled by the snapshot, and the snapshot arrives *after* sign-in. A bare key
   *  would put "kiosk" in front of an operator where the outlet's own sign says Snack Kiosk. */
  locs: z.array(SignInCounterSchema).max(32).default([]),
});
export const SignInDirectorySchema = z.array(SignInEntrySchema);
/**
 * Where this account may work, and where this session currently is.
 *
 * A counter operator takes shifts at more than one outlet, so `postings` is every counter they
 * are allowed to stand at and `user.loc` is the one they are standing at now - which is what the
 * token's `loc` claim carries and therefore what every location guard on the server tests. One
 * posting is the ordinary case and means the sign-in screen shows no picker at all.
 *
 * It is on the authenticated response, never on the public directory: which counters a named
 * employee works is not something to hand out before anybody has signed in.
 */
export const PostingsSchema = z.array(LocKeySchema).max(32);
export const AuthResponseSchema = z.object({
  accessToken: z.string(), user: UserSchema, mustChangePassword: z.boolean(),
  postings: PostingsSchema.default([]),
});
/** The floor every new password clears, wherever one is set: the change-password form below and
 *  the two administrator commands behind `pnpm --filter @rch/api users` (`createUser` and
 *  `resetPassword`, apps/api/src/lib/users-admin.ts). One number rather than two literals, so a
 *  temporary password typed by an administrator can never be weaker than one the user could
 *  have chosen for themselves. */
export const MIN_PASSWORD_LENGTH = 10;
export const ChangePasswordBodySchema = z.strictObject({ current: z.string().min(1).max(200), next: z.string().min(MIN_PASSWORD_LENGTH).max(200) });
/**
 * Every string is bounded. These reach `users` and from there every snapshot the account is in,
 * so an unbounded `n` is a row that gets read back on every sign-in by everyone who can see the
 * roster. The ceilings are what the columns will ever need: a display name, a phone number as it
 * is written on a lanyard, and the 254 characters an email address can be at most (RFC 5321).
 */
export const PatchMeBodySchema = z.strictObject({ n: z.string().trim().min(1).max(120).optional(), e: z.email().max(254).optional(), ph: z.string().trim().min(5).max(40).optional() });
export const MeResponseSchema = z.object({ user: UserSchema, mustChangePassword: z.boolean() });
