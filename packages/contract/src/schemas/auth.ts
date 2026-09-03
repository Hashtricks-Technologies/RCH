import { z } from "zod";
import { UserSchema } from "./documents";

export const LoginBodySchema = z.object({ emp: z.string().trim().min(1), password: z.string().min(1) });
export const AuthResponseSchema = z.object({ accessToken: z.string(), user: UserSchema, mustChangePassword: z.boolean() });
export const ChangePasswordBodySchema = z.object({ current: z.string().min(1), next: z.string().min(10).max(200) });
export const PatchMeBodySchema = z.object({ n: z.string().trim().min(1).optional(), e: z.email().optional(), ph: z.string().trim().min(5).optional() }).strict();
export const MeResponseSchema = z.object({ user: UserSchema, mustChangePassword: z.boolean() });
