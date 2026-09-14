import { z } from "zod";
import { UserSchema } from "./documents.js";

/** Request bodies are strict: an unknown key is a client bug (a renamed field, a stale build),
 *  and silently dropping it hides the mistake until someone wonders why the value never saved. */
export const LoginBodySchema = z.strictObject({ emp: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) });
/** One line of the sign-in screen's employee picker: the number and the name, nothing else. The
 *  list is public (it is read before anybody has signed in), so it carries no role, location,
 *  email or phone, and never an admin-flagged or deactivated account. */
export const SignInEntrySchema = z.strictObject({ emp: z.string(), n: z.string() });
export const SignInDirectorySchema = z.array(SignInEntrySchema);
export const AuthResponseSchema =z.object({ accessToken: z.string(), user: UserSchema, mustChangePassword: z.boolean() });
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
