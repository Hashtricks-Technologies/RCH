// Reports: the two figures the browser cannot compute from its own snapshot — the central store's
// stock ledger, which needs the ledger's own moves, and a payer's credit for the calendar month,
// which needs every outlet's bills and not the till's own seven days.
//
// service.ts: the flow. Neither read is a write, so there is no transaction, no lock and no
// `emitChanged` here — and the ledger's arithmetic is `ledgerRow` in @rch/domain, not a sum
// written out again in this file. The SQL adds up; the domain decides what the columns mean.
import type { CreditParams, CreditResponse, StockLedgerQuery, StockLedgerResponse } from "@rch/contract";
import { creditRoom, ledgerRow, STAFF_CREDIT_LIMIT } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { creditTakenThisMonth } from "../../lib/credit.js";
import { NotFoundError } from "../../lib/errors.js";
import { reportsRepo } from "./repo.js";

export function createReportsService(db: Db) {
  return {
    /**
     * One location's ledger over the last `days`: opening, received, issued, closing, per item.
     *
     * The browser had no stock moves at all, so its opening balance was today's closing worked
     * backwards through goods receipts and collected tickets — arithmetic a withdrawn ticket
     * walked by exactly the quantity it never moved. This sums the moves either side of the
     * window instead, which makes the closing column the same number `stock_balances` carries
     * and the same number `db:rebuild-balances` arrives at from the other direction.
     */
    async stockLedger(q: StockLedgerQuery): Promise<StockLedgerResponse> {
      const to = new Date();
      const from = new Date(to.getTime() - q.days * 86_400_000);
      // Three reads, not one snapshot: no transaction holds `openingAt`, `movedIn` and
      // `carriedAt` together, so a write can land between them. The worst case is a balance that
      // is created in that gap — it lands in one of the three and not the others, and the row
      // this builds for it comes out all zeros (opening, recd, issued and closing alike). That is
      // a correct answer, not a torn one: this report holds no lock, because it promises nothing
      // for anyone else to be torn against.
      const [before, inWindow, carried] = await Promise.all([
        reportsRepo.openingAt(db, q.loc, from),
        reportsRepo.movedIn(db, q.loc, from, to),
        reportsRepo.carriedAt(db, q.loc),
      ]);
      // Every item this location has ever carried, so a line that opened at 40 and moved nothing
      // still appears — the shelf is there whether or not this window touched it.
      const keys = [...new Set([...before.keys(), ...inWindow.keys(), ...carried])].sort();
      const rows = keys.map((it) => {
        const w = inWindow.get(it) ?? { recd: 0, issued: 0 };
        // `ledgerRow` takes signed moves; the SQL has already split them, so hand it the two
        // numbers as a two-element window rather than reimplementing the arithmetic here.
        return ledgerRow(it, before.get(it) ?? 0, [w.recd, -w.issued]);
      });
      return { loc: q.loc, from: from.toISOString(), to: to.toISOString(), rows };
    },

    /**
     * What one payer has put on credit this calendar month, and how much room is left.
     *
     * The number is `creditTakenThisMonth` — the same query `POST /bills` refuses on, in
     * `apps/api/src/lib/credit.ts` so there is one of it. No lock is taken: the sale's
     * `pg_advisory_xact_lock` belongs to the sale, and a report holding it would put every till
     * behind whoever opened the credit screen.
     */
    async credit(p: CreditParams): Promise<CreditResponse> {
      const payer = await reportsRepo.payer(db, p.kind, p.id);
      if (!payer) throw new NotFoundError(`There is nobody on the roster with the number ${p.id}.`);
      const { taken, since } = await creditTakenThisMonth(db, p.kind, p.id);
      return { kind: p.kind, id: p.id, name: payer.name, since: since.toISOString(), taken, limit: STAFF_CREDIT_LIMIT, room: creditRoom(taken) };
    },
  };
}
