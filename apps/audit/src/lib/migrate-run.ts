import { sql } from "drizzle-orm";
import { escapeIdentifier } from "pg";
import type { AuditConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { appliedMigrationCount, journalLength, runMigrations } from "../db/migrate.js";
import { ensureLoginRole, grantAuditRole, roleFromUrls } from "./roles.js";

/** The API's migrate CLI holds 727272; the audit step takes the next number, so the two never
 *  wait on each other and two audit replicas never migrate at once. */
export const AUDIT_MIGRATE_LOCK = 727273;

/** The API's migrate lock. Its migrate step grants on `audit_outbox` too, and two GRANTs on one
 *  relation at the same moment can fail with "tuple concurrently updated" (XX000), so the role and
 *  grant step below runs under this lock as well. The API never takes 727273, so waiting for 727272
 *  while holding 727273 cannot deadlock. */
export const API_MIGRATE_LOCK = 727272;

/** Spec §4: the two migrate steps may start in either order on Kubernetes, so this one waits up to
 *  five minutes, looking every two seconds, for the API's migration to create the outbox. */
export const OUTBOX_WAIT = { timeoutMs: 5 * 60_000, intervalMs: 2_000 } as const;

export type WaitOptions = {
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (elapsedMs: number) => void;
};

/** The outbox never appeared: the API's migrations have not run against this database. */
export class OutboxMissingError extends Error {}

/** Asks `exists` at once and then every `intervalMs` until it says yes (true) or `timeoutMs` has
 *  passed (false). The clock and the sleep are injectable so a test does not wait five minutes. */
export async function waitForOutbox(exists: () => Promise<boolean>, opts: WaitOptions): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  for (;;) {
    if (await exists()) return true;
    const elapsed = now() - start;
    if (elapsed >= opts.timeoutMs) return false;
    opts.onWait?.(elapsed);
    await sleep(Math.min(opts.intervalMs, opts.timeoutMs - elapsed));
  }
}

export async function outboxExists(db: Db, outboxSchema: string): Promise<boolean> {
  const r = await db.execute(sql`select to_regclass(${`${escapeIdentifier(outboxSchema)}.audit_outbox`}) is not null as ok`);
  return (r.rows[0] as { ok: boolean }).ok;
}

/**
 * The whole migrate step: take the advisory lock, wait for the outbox, apply the audit migrations,
 * then - when the runtime URL names its own user - create that login role and grant it, holding the
 * API's lock too for that part.
 *
 * `db` must be a single-connection pool (`max: 1`) on `search_path = config.auditSchema`: an
 * advisory lock belongs to the session that took it, so the lock, the migrations and the unlock
 * have to share one. `lock_timeout = 0` makes the wait for another replica explicit.
 */
export async function migrateAudit(
  db: Db,
  config: AuditConfig,
  opts: { wait?: Partial<WaitOptions>; log?: (line: string) => void } = {},
): Promise<{ applied: number; expected: number; role: string | null }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const wait: WaitOptions = { ...OUTBOX_WAIT, ...opts.wait };
  const role = roleFromUrls(config.databaseUrl, config.migrateDatabaseUrl);
  await db.execute(sql`set lock_timeout = 0`);
  await db.execute(sql.raw(`select pg_advisory_lock(${AUDIT_MIGRATE_LOCK})`));
  try {
    const found = await waitForOutbox(() => outboxExists(db, config.outboxSchema), {
      ...wait,
      onWait: (ms) => log(`Waiting for ${config.outboxSchema}.audit_outbox, which the API's migrations create (${Math.round(ms / 1000)} s so far).`),
    });
    if (!found) {
      throw new OutboxMissingError(`There is still no ${config.outboxSchema}.audit_outbox after ${Math.round(wait.timeoutMs / 1000)} s. Run the API's migrations against this database first.`);
    }
    await runMigrations(db, config.auditSchema);
    if (role) {
      await db.execute(sql.raw(`select pg_advisory_lock(${API_MIGRATE_LOCK})`));
      try {
        await ensureLoginRole(db, role);
        await grantAuditRole(db, role.name, { auditSchema: config.auditSchema, outboxSchema: config.outboxSchema });
      } finally {
        await db.execute(sql.raw(`select pg_advisory_unlock(${API_MIGRATE_LOCK})`));
      }
    }
    return { applied: await appliedMigrationCount(db, config.auditSchema), expected: journalLength(), role: role?.name ?? null };
  } finally {
    await db.execute(sql.raw(`select pg_advisory_unlock(${AUDIT_MIGRATE_LOCK})`));
  }
}
