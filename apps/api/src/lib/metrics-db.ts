import { Counter, Gauge, type Registry } from "prom-client";

/** Just the counters `pg.Pool` publishes — typed structurally so lib/ needs no Fastify or pg import. */
type PoolCounts = { totalCount: number; idleCount: number; waitingCount: number };

/**
 * The database side of /metrics, kept out of plugins/ so that lib/ can report on itself
 * without importing Fastify. `recordAllocation` is a no-op until an app calls `bindMetrics`,
 * which is what lets `allocateId` count unconditionally — a CLI or a test with no app still runs.
 */
let allocations: Counter<"kind"> | undefined;

/** Called by plugins/metrics.ts once per app, with that app's registry. */
export function bindMetrics(registry: Registry): void {
  allocations = new Counter({
    name: "sequence_allocations_total", help: "Document numbers handed out, by series",
    labelNames: ["kind"], registers: [registry],
  });
}

/** One document number was handed out. Counts attempts: a sale the post-lock check rolls back
 *  gives its number back (see lib/ids.ts) but has already been counted here, so read this as
 *  "allocations tried", not "documents committed". Silent until an app has bound a registry. */
export function recordAllocation(kind: string): void {
  allocations?.labels(kind).inc();
}

/** Pool depth is read at scrape time, not sampled: a gauge that lags hides the exhaustion it exists to show. */
export function registerPoolGauges(registry: Registry, pool: PoolCounts): void {
  const gauge = (name: string, help: string, read: () => number) =>
    new Gauge({ name, help, registers: [registry], collect() { this.set(read()); } });
  gauge("pg_pool_total", "Connections the pool holds", () => pool.totalCount);
  gauge("pg_pool_idle", "Connections the pool holds that are idle", () => pool.idleCount);
  gauge("pg_pool_waiting", "Requests queued for a connection", () => pool.waitingCount);
}
