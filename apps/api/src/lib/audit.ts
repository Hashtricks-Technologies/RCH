import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { API_PREFIX, AuditEventSchema, CollectionSchema, type AuditActor, type AuditEvent, type AuditOutcome, type Changed } from "@rch/contract";
import type { Db } from "../db/client.js";
import { auditOutbox, users } from "../db/schema/index.js";
import { idemStore, type IdemContext } from "../plugins/idempotency.js";
import type { Reader, Tx } from "./db.js";
import { roleLabelOf } from "./wire.js";

/**
 * The API's half of the audit trail: every event the API emits is built here and stored here, and
 * `scripts/check-boundaries.sh` holds the insert to this one file.
 *
 * The API only ever adds to `audit_outbox`. The audit service (`apps/audit`) moves each row into
 * its own append-only schema and removes it; nothing in this process reads the outbox back, and in
 * production its database role could not if it tried.
 */

/**
 * The NOTIFY channel that wakes the drainer. Its payload is the schema the outbox row went into
 * (`public` in production): a channel belongs to the database, every test file owns a schema, and
 * the payload is how a listener tells its own outbox's notices from another file's.
 */
export const AUDIT_OUTBOX_CHANNEL = "rch_audit_outbox";

/** What a secret reads as once masked. */
export const MASK = "••••";

/**
 * The keys whose values are never stored, matched by exact name: `password`/`newPassword`/
 * `currentPassword` (any password field), `tempPassword` (the account create and reset responses,
 * `schemas/admin.ts`), `otp` (a handover's body and every ticket), and the token and secret names.
 *
 * A name list rather than a pattern. A pattern that caught every password also caught
 * `mustChangePassword`, the one field a password reset visibly changes, and hid it from the
 * before → after. `current` and `next` - the change-password body - are deliberately absent: they
 * are ordinary words elsewhere, and that request is recorded by the auth module with `request: {}`.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set(["password", "newPassword", "currentPassword", "tempPassword", "otp", "token", "accessToken", "refreshToken", "secret"]);

/** A copy of any JSON value with the value of every `SECRET_KEYS` key replaced by `MASK`, at any
 *  depth. Applied to what was sent, what came back and what stood before, so a password, a
 *  temporary password or a handover code is never stored - the outcome is. */
export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => maskSecrets(v)) as T;
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.has(k) ? MASK : maskSecrets(v)])) as T;
}

/** A field of something the request or the response carried, as text when it is text or a number
 *  (`n`, a PO line, arrives coerced). Anything else - absent, nested, a refusal's raw body - is
 *  `undefined`, so a target is never "[object Object]". */
const text = (o: unknown, key: string): string | undefined => {
  if (o === null || typeof o !== "object") return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
};
const joined = (sep: string, ...parts: Array<string | undefined>): string =>
  parts.filter((p): p is string => p !== undefined && p !== "").join(sep);

/**
 * What an event is about, and where. Most writes name one document - by its id, a bill by its
 * number, an item by its key - in the path or, for a create, in the result. Four kinds name a cell
 * rather than a row, and one field alone would be ambiguous there: a price is a list and an item, a
 * menu listing and an availability switch are a location and an item, and a PO line is an order
 * and a line number.
 *
 * The location is the one the request names - `loc`, or a transfer's `from` - else the one the
 * result carries: `loc`, or the `from` a stock request, a ticket or a shop ask records.
 */
export function targetOf(action: string, params: unknown, body: unknown, result: unknown): { target: string; targetLoc: string } {
  const targetLoc = text(params, "loc") ?? text(body, "loc") ?? text(body, "from") ?? text(result, "loc") ?? text(result, "from") ?? "";
  switch (action) {
    case "savePrice":
      return { target: joined(":", text(params, "list"), text(params, "it")), targetLoc };
    case "addMenuItem":
    case "removeMenuItem":
      return { target: joined(":", text(params, "loc"), text(params, "it") ?? text(body, "it")), targetLoc };
    case "toggleAvail":
      return { target: joined(":", text(body, "loc"), text(body, "it")), targetLoc };
    case "updatePoLine":
    case "removePoLine":
      return { target: joined("#", text(params, "id"), text(params, "n")), targetLoc };
    default:
      return {
        target: text(params, "id") ?? text(params, "no") ?? text(params, "it") ?? text(result, "id") ?? text(result, "no") ?? text(result, "key") ?? "",
        targetLoc,
      };
  }
}

/**
 * Who acted, as they stood at that moment: the event keeps the number, name, role label and
 * location rather than a reference, so it still reads after the account is renamed, moved or
 * deleted. One primary-key read.
 *
 * - No user (a sign-in for a number nobody holds): `id` null and, where one was typed, the employee
 *   number the caller gave, capped at 64.
 * - A user id with no row (deleted while its token was still live): the id alone.
 * - The super admin: `Super Admin` and no location - its `role`/`loc` columns are placeholders
 *   nothing acts on (`lib/wire.ts`), and printing one would put it at a desk it never sits at.
 */
export async function actorOf(db: Reader, userId: string | null, typedEmp = ""): Promise<AuditActor> {
  const emp = typedEmp.slice(0, 64);
  if (userId === null) return { id: null, emp, name: "", role: "", loc: "" };
  const [u] = await db
    .select({ empNo: users.empNo, name: users.name, roleLabel: users.roleLabel, admin: users.admin, loc: users.loc })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return { id: userId, emp, name: "", role: "", loc: "" };
  return { id: userId, emp: u.empNo, name: u.name, role: roleLabelOf(u), loc: u.admin ? "" : u.loc };
}

/**
 * Store one event and wake the drainer.
 *
 * The event is parsed with the same `AuditEventSchema` the drainer parses it with, in every
 * environment. An event the drainer would dead-letter is a bug in the code that built it, and here
 * it surfaces at its source: inside a write's transaction it takes the write down (a write that
 * cannot be audited does not commit), and on the pool `plugins/audit.ts` logs it. The schema holds
 * the request, result and before values as `unknown`, so the parse walks none of them.
 *
 * On a transaction, Postgres holds the NOTIFY until COMMIT, so a write that rolls back wakes nobody.
 */
export async function insertAuditEvent(db: Db | Tx, event: AuditEvent): Promise<void> {
  const parsed = AuditEventSchema.parse(event);
  await db.insert(auditOutbox).values({ at: new Date(parsed.at), event: parsed });
  await db.execute(sql`select pg_notify(${AUDIT_OUTBOX_CHANNEL}, current_schema())`);
}

/** The browser's own description of itself, capped: it is stored forever and only ever read as a device. */
const userAgentOf = (headers: Record<string, string | string[] | undefined>): string => {
  const ua = headers["user-agent"];
  return (Array.isArray(ua) ? ua[0] ?? "" : ua ?? "").slice(0, 512);
};

/**
 * A sign-in, sign-out or password change. The auth routes are public or `write: false`, so `mount()`
 * never audits them and `modules/auth` records each one itself.
 *
 * No password is ever passed in. `request`, when given, is stored (masked) as what was sent; left
 * out, the event keeps the path's params and query and never the body, because the change-password
 * body's `current` and `next` are not `SECRET_KEYS`.
 */
export type AuthEvent = {
  action: "login" | "logout" | "changePassword"; outcome: AuditOutcome; status: number; message: string;
  cause?: string | null; actorId: string | null; typedEmp?: string; request?: unknown;
};

export async function recordAuthEvent(db: Db, req: FastifyRequest, e: AuthEvent): Promise<void> {
  const url = req.routeOptions.url ?? req.url;
  await insertAuditEvent(db, {
    at: new Date().toISOString(), requestId: req.id,
    actor: await actorOf(db, e.actorId, e.typedEmp),
    action: e.action, method: req.method, path: url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url,
    target: "", targetLoc: "",
    outcome: e.outcome, status: e.status, message: e.message, cause: e.cause ?? null,
    request: maskSecrets(e.request ?? { params: req.params ?? {}, query: req.query ?? {} }),
    before: null, result: null, changed: [],
    ip: req.ip, userAgent: userAgentOf(req.headers),
  });
}

/**
 * What `mount()` knows about a non-public write before its handler runs. The same object is
 * `req.audit` and the write's `IdemContext.audit`, handed to `idemStore` by reference, so the
 * transaction that records the write (`lib/db.ts`) and the hook that records a refusal
 * (`plugins/audit.ts`) read one account of the request.
 *
 * `pending` is set inside the transaction that inserted the write's `done` event and cleared once
 * that transaction settles; `recorded` is set only when it committed. A request whose event was
 * inserted but whose COMMIT then failed is therefore not `recorded`, and the hook stores its error event.
 */
export type AuditRequestContext = {
  action: string; method: string; path: string;
  requestId: string; ip: string; userAgent: string;
  params: unknown; query: unknown; body: unknown;
  actorId: string | null;
  before: unknown | null;
  pending: boolean;
  recorded: boolean;
};
declare module "fastify" { interface FastifyRequest { audit?: AuditRequestContext } }

/** The parts of a request an audit context is read from - a structural type, so `mount()`'s
 *  route-typed `Req<R>` and the hook's plain `FastifyRequest` both fit without a cast. */
type AuditedRequest = {
  id: string; ip: string; headers: Record<string, string | string[] | undefined>;
  params: unknown; query: unknown; body: unknown;
  user?: { sub: string } | null;
};

/** A fresh context for one request. `user` is null until a token has been verified (`@fastify/jwt`
 *  decorates it so), which is what leaves a refusal before sign-in without an actor. */
export function auditContextOf(req: AuditedRequest, route: { action: string; method: string; path: string }): AuditRequestContext {
  return {
    action: route.action, method: route.method, path: route.path,
    requestId: req.id, ip: req.ip, userAgent: userAgentOf(req.headers),
    params: req.params ?? {}, query: req.query ?? {}, body: req.body ?? null,
    actorId: req.user?.sub ?? null,
    before: null, pending: false, recorded: false,
  };
}

/** A reply read as a write's `{ result, changed, message }`. A response of another shape (`PATCH
 *  /me` answers with the account itself) is all result, with no sentence and nothing changed; a
 *  collection this build does not know is dropped, since the fallback path reads bytes nobody
 *  parsed against the manifest. */
export function writeOutcomeOf(body: unknown): { result: unknown; changed: Changed[]; message: string } {
  if (body === null || typeof body !== "object" || !("result" in body) || !("message" in body)) return { result: body ?? null, changed: [], message: "" };
  const w = body as { result: unknown; changed?: unknown; message: unknown };
  const changed = Array.isArray(w.changed) ? w.changed.filter((c): c is Changed => CollectionSchema.safeParse(c).success) : [];
  return { result: w.result ?? null, changed, message: typeof w.message === "string" ? w.message : "" };
}

/** One event from a request's context and how it ended. Masking happens here, once, for every
 *  path that stores an event. */
export async function auditEventOf(
  db: Reader,
  a: AuditRequestContext,
  o: { outcome: AuditOutcome; status: number; message: string; cause: string | null; result: unknown; changed: Changed[] },
): Promise<AuditEvent> {
  const { target, targetLoc } = targetOf(a.action, a.params, a.body, o.result);
  return {
    at: new Date().toISOString(), requestId: a.requestId,
    actor: await actorOf(db, a.actorId),
    action: a.action, method: a.method, path: a.path, target, targetLoc,
    outcome: o.outcome, status: o.status, message: o.message, cause: o.cause,
    request: maskSecrets({ params: a.params, query: a.query, body: a.body }),
    before: maskSecrets(a.before ?? null), result: maskSecrets(o.result ?? null), changed: o.changed,
    ip: a.ip, userAgent: a.userAgent,
  };
}

/**
 * The `done` event of a write that succeeded, stored by the transaction that recorded the write's
 * idempotency outcome, straight after that record (`withTransaction`, `lib/db.ts`). It commits with
 * the write or not at all, and it is deliberately not wrapped in a try/catch: a write that cannot
 * be audited does not commit, the same stance the idempotency record takes.
 *
 * `body` is the response as the route's schema parsed it - exactly what the key will replay.
 */
export async function recordAudit(tx: Tx, ctx: IdemContext, body: unknown): Promise<void> {
  const w = writeOutcomeOf(body);
  await insertAuditEvent(tx, await auditEventOf(tx, ctx.audit, { outcome: "done", status: 200, message: w.message, cause: null, result: w.result, changed: w.changed }));
  ctx.audit.pending = true;
}

/**
 * What an edit is about to change, as it stood: a service calls this once it has read the row it is
 * about to update or remove and before it changes anything, with the wire-shaped fields the edit can
 * alter. The value rides on the request's audit context, so the `done` event shows before → after -
 * and a refused edit's event carries it too. The last call wins. Outside a write request (a CLI, the
 * seed) there is no context, and nothing to keep.
 */
export function auditBefore(value: Record<string, unknown>): void {
  const ctx = idemStore.getStore();
  if (ctx) ctx.audit.before = value;
}
