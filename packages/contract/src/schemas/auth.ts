import { z } from "zod";
import { UserSchema } from "./documents.js";

/** Request bodies are strict: an unknown key is a client bug (a renamed field, a stale build),
 *  and silently dropping it hides the mistake until someone wonders why the value never saved. */
export const LoginBodySchema = z.strictObject({ emp: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) });
export const AuthResponseSchema = z.object({ accessToken: z.string(), user: UserSchema, mustChangePassword: z.boolean() });
export const ChangePasswordBodySchema = z.strictObject({ current: z.string().min(1).max(200), next: z.string().min(10).max(200) });
export const PatchMeBodySchema = z.strictObject({ n: z.string().trim().min(1).optional(), e: z.email().optional(), ph: z.string().trim().min(5).optional() });
export const MeResponseSchema = z.object({ user: UserSchema, mustChangePassword: z.boolean() });
