import { z } from "zod";
import { CollectionSchema } from "./writes.js";

/**
 * The audit log's wire shapes. The API writes an `AuditEvent` into its outbox inside the write's
 * own transaction; `apps/audit` drains it, stores it and serves it back as rows and entries. Both
 * services parse with these schemas, so an event one side builds is an event the other accepts.
 */
export const AUDIT_OUTCOMES = ["done", "refused", "error"] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/** The areas the Audit log's filter offers. Their printed names are `AUDIT_GROUPS` in `../audit.ts`. */
export const AUDIT_GROUP_KEYS = ["sales", "stock", "purchasing", "production", "master", "accounts", "support"] as const;
export const AuditGroupSchema = z.enum(AUDIT_GROUP_KEYS);
export type AuditGroup = z.infer<typeof AuditGroupSchema>;

/** Who acted, as they stood at that moment. `role` is the printed label ("Super Admin" included)
 *  and `id` is null for a sign-in attempt against an employee number nobody holds, where `emp` is
 *  what was typed. Plain strings rather than `RoleSchema`/`LocKeySchema`: the row outlives any
 *  rename, and a deleted account still reads. */
export const AuditActorSchema = z.strictObject({
  id: z.string().nullable(), emp: z.string(), name: z.string(), role: z.string(), loc: z.string(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

/** One audited action. `action` is a string and not `AuditAction`, deliberately: a route removed
 *  from the manifest must not turn its history into dead letters. Secrets are masked before an
 *  event is built, so nothing here ever carries a password, an OTP or a token. */
export const AuditEventSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  requestId: z.string(),
  actor: AuditActorSchema,
  action: z.string().min(1).max(64),
  method: z.string(), path: z.string(),
  target: z.string(), targetLoc: z.string(),
  outcome: AuditOutcomeSchema,
  status: z.number().int(),
  message: z.string(),
  cause: z.string().nullable(),
  request: z.unknown(),
  before: z.unknown().nullable(),
  result: z.unknown().nullable(),
  changed: z.array(CollectionSchema),
  ip: z.string(), userAgent: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** One line of the Audit log's table. `ip` and `requestId` ride on the row rather than only on the
 *  entry because the CSV export prints both, and it pages rows, not entries. */
export const AuditRowSchema = z.strictObject({
  id: z.number().int(), at: z.string(), actor: AuditActorSchema, action: z.string(),
  target: z.string(), targetLoc: z.string(), outcome: AuditOutcomeSchema, status: z.number().int(), message: z.string(),
  ip: z.string(), requestId: z.string(),
});
export type AuditRow = z.infer<typeof AuditRowSchema>;

/** What the drawer opens: the row plus everything the table leaves out. `changed` is plain
 *  strings, because a stored collection name outlives the enum it was drawn from. */
export const AuditEntrySchema = AuditRowSchema.extend({
  method: z.string(), path: z.string(), cause: z.string().nullable(),
  request: z.unknown(), before: z.unknown().nullable(), result: z.unknown().nullable(),
  changed: z.array(z.string()), userAgent: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** The four figures above the table, counted over the whole filter and not over the page. */
export const AuditCountsSchema = z.strictObject({
  events: z.number().int(), people: z.number().int(), refused: z.number().int(), failedSignIns: z.number().int(),
});
export type AuditCounts = z.infer<typeof AuditCountsSchema>;

/** `next` is the id to pass back as `before` for the following page, or null on the last one. */
export const AuditPageSchema = z.strictObject({
  rows: z.array(AuditRowSchema), next: z.number().int().nullable(), counts: AuditCountsSchema,
});
export type AuditPage = z.infer<typeof AuditPageSchema>;

/** A hospital day, `YYYY-MM-DD` in Asia/Kolkata. The audit service turns it into instants. */
const IstDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Every filter is optional and `limit` is defaulted, so a bare `GET /admin/audit` is today's
 *  first hundred events. `before` and `limit` arrive as strings in a URL and are coerced. */
export const AuditQuerySchema = z.strictObject({
  from: IstDay.optional(), to: IstDay.optional(),
  actor: z.string().max(64).optional(), role: z.string().max(40).optional(), loc: z.string().max(40).optional(),
  group: AuditGroupSchema.optional(), action: z.string().max(64).optional(), outcome: AuditOutcomeSchema.optional(),
  q: z.string().max(100).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export const AuditIdParamsSchema = z.strictObject({ id: z.coerce.number().int().positive() });
