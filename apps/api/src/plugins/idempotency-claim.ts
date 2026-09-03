export type ClaimRow = { requestHash: string; statusCode: number; response: unknown; createdAt: Date };
export type ClaimOutcome =
  | { kind: "proceed" } // we hold the row (fresh claim or successful takeover)
  | { kind: "replay"; statusCode: number; response: unknown }
  | { kind: "conflict" } // same key, different payload -> 409
  | { kind: "in_progress" }; // someone else holds a live claim -> 409

/**
 * The one rule this loop exists to enforce: a request may proceed only while it holds a
 * claim row. `ops.tryInsert` either wins the row outright or (on conflict) `ops.lookup`
 * reads what is there — and if that finds nothing, the row was purged between the two
 * statements (deleted by `onSend` for a 429/503, most commonly). That used to be treated as
 * "nobody's claiming it, run anyway"; that is exactly the bare-run hole this module closes.
 * Finding nothing is not a green light — it is a reason to retry the insert, because the
 * only way to hold a claim is to either insert it or take over a stale one.
 */
export async function resolveClaim(ops: {
  tryInsert: () => Promise<boolean>; // INSERT ... ON CONFLICT DO NOTHING RETURNING -> inserted?
  lookup: () => Promise<ClaimRow | undefined>;
  tryTakeover: () => Promise<boolean>; // UPDATE ... WHERE status_code = 0 AND created_at < stale RETURNING -> rows > 0
  requestHash: string;
  staleMs: number;
  now: () => number;
  maxAttempts?: number;
}): Promise<ClaimOutcome> {
  const maxAttempts = ops.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await ops.tryInsert()) return { kind: "proceed" };

    const hit = await ops.lookup();
    if (!hit) continue; // purged out from under us - retry the insert, never proceed bare
    if (hit.requestHash !== ops.requestHash) return { kind: "conflict" };
    if (hit.statusCode !== 0) return { kind: "replay", statusCode: hit.statusCode, response: hit.response };

    const isStale = ops.now() - hit.createdAt.getTime() >= ops.staleMs;
    if (!isStale) return { kind: "in_progress" };
    if (await ops.tryTakeover()) return { kind: "proceed" };
    // Lost the takeover race (someone else took or refreshed it first) - loop and reassess.
  }
  return { kind: "in_progress" };
}
