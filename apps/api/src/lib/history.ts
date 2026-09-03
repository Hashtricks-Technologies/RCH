import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { documentHistory } from "../db/schema/index.js";
import type { Tx } from "./db.js";
import { iso } from "./time.js";

export type HistEntry = { s: string; who: string; t: string };

export async function appendHistory(tx: Tx, docType: string, docId: string, status: string, who: string, at: Date = new Date()): Promise<void> {
  await tx.insert(documentHistory).values({ docType, docId, status, who, at });
}
export async function readHistory(db: Db | Tx, docType: string, docId: string): Promise<HistEntry[]> {
  const rows = await db.select().from(documentHistory)
    .where(and(eq(documentHistory.docType, docType), eq(documentHistory.docId, docId)))
    .orderBy(asc(documentHistory.at), asc(documentHistory.id));
  return rows.map((r) => ({ s: r.status, who: r.who, t: iso(r.at) }));
}
/** One query for many documents — the snapshot readers use this instead of N round trips. */
export async function readHistories(db: Db | Tx, docType: string): Promise<Map<string, HistEntry[]>> {
  const rows = await db.select().from(documentHistory).where(eq(documentHistory.docType, docType))
    .orderBy(asc(documentHistory.at), asc(documentHistory.id));
  const m = new Map<string, HistEntry[]>();
  for (const r of rows) { const a = m.get(r.docId) ?? []; a.push({ s: r.status, who: r.who, t: iso(r.at) }); m.set(r.docId, a); }
  return m;
}
