// Production: the two ways the kitchen puts stock on a ticket. Both reserve and neither moves
// — approval authorises, the scan moves (CLAUDE.md), and `handover` is still what empties the
// shelf. Batches, `makeProduct` and the board's own statuses stay in memory for Phase 4: they
// create no ticket, so they cross no seam.
import type { z } from "zod";
import type { DistributeBodySchema, ProdOrder, Ticket, WriteResponse } from "@rch/contract";
import { canTransition, fq, PROD_ORDER_TRANSITIONS, round3 } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { lockBalances } from "../../lib/ledger.js";
import { loadMaster } from "../../lib/master.js";
import { reservedAt } from "../../lib/reservations.js";
import { assertRule } from "../../lib/rules.js";
import { allocateTicket, writeTicket } from "../../lib/tickets.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { productionRepo } from "./repo.js";

export type DistributeBody = z.infer<typeof DistributeBodySchema>;
export type DispatchResult = { order: ProdOrder; ticket: Ticket };

/** Both paths leave from the kitchen: the `prod` role has exactly one, and neither endpoint
 *  lets the caller name a source. Pinned here rather than read off the request. */
const KITCHEN = "kitchen";

export function createProductionService(db: Db) {
  return {
    /**
     * One production order onto one ticket, addressed to the outlet that asked for it.
     *
     * The order row is read `for update` first, so two screens pressing Dispatch together
     * cannot both find it open. Then ids before balance locks, always (`lib/ledger.ts`'s
     * header): the ticket's number is taken before the kitchen's shelves are locked, so a sale
     * holding the sequences row and a dispatch holding a shelf can never wait on each other.
     */
    async dispatch(claims: AccessClaims, id: string): Promise<WriteResponse<DispatchResult>> {
      return withTransaction(db, async (tx) => {
        const o = await productionRepo.head(tx, id);
        if (!o) throw new NotFoundError(`There is no production order ${id}.`);
        const master = await loadMaster(tx);
        const to = master.locations[o.fromLoc];
        // The table decides; the sentence only explains. PROD_ORDER_TRANSITIONS is the same
        // data the board's Dispatch button is drawn from (spec §5.1), so a stage the UI offers
        // and a stage the server accepts cannot drift apart. One order, one ticket: dispatching
        // twice would raise a second ticket for stock already promised, which is how half an
        // order ends up in two places — so the refusal names where that stock already went.
        assertRule(
          canTransition(PROD_ORDER_TRANSITIONS, o.status, "Dispatched"),
          o.status === "Declined"
            ? `${id} was declined — it cannot be dispatched`
            : `${id} has already gone out — it is on one ticket to ${to.n}`,
        );

        // Fold a repeated item into a single line so the cover check is made against the whole
        // quantity the order asks for, not one line of it at a time.
        const folded = new Map<string, number>();
        for (const l of await productionRepo.lines(tx, id)) folded.set(l.it, round3((folded.get(l.it) ?? 0) + l.qty));
        const lines = [...folded].map(([it, qty]) => ({ it, qty }));
        assertRule(lines.length > 0, `${id} has no items on it`);

        const at = new Date();
        const no = await allocateTicket(tx, at);
        await lockBalances(tx, lines.map((l) => ({ loc: KITCHEN, it: l.it })));
        const stock = await productionRepo.balancesAt(tx, KITCHEN, lines.map((l) => l.it));
        const held = await reservedAt(tx, KITCHEN, lines.map((l) => l.it));
        // All or nothing: a part-dispatched order leaves the outlet guessing what is still
        // coming, so every item short is named and nothing moves.
        const short = lines.filter((l) => round3((stock[l.it] ?? 0) - (held[`${KITCHEN}:${l.it}`] ?? 0)) < l.qty);
        assertRule(short.length === 0, `Nothing dispatched — the kitchen is short of ${short.map((l) => master.items[l.it]?.n ?? l.it).join(", ")}`);

        const ticket = await writeTicket(tx, { refType: "prod_order", refId: id, from: KITCHEN, to: o.fromLoc, lines, by: claims.sub, at }, no);
        await productionRepo.setStatus(tx, id, "Dispatched");
        const who = await productionRepo.userName(tx, claims.sub);
        await appendHistory(tx, "prod_order", id, "Dispatched", who, at);

        const changed = ["pord", "tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        return {
          result: { order: await productionRepo.wire(tx, id), ticket },
          changed: [...changed],
          message: `${ticket.id} issued — all ${lines.length} item${lines.length === 1 ? "" : "s"} of ${id} reserved for ${to.n}`,
        };
      });
    },

    /**
     * A tray the kitchen decided to push out: no order behind it, so the ticket's reference is
     * the words "Direct issue" rather than a document id. Same lock order as a dispatch, same
     * promise — the stock is held at the kitchen and moves when the collector's scan lands.
     */
    async distribute(claims: AccessClaims, body: DistributeBody): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        assertRule(body.qty > 0, "Enter a quantity");
        const master = await loadMaster(tx);
        const item = master.items[body.it];
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);
        const to = master.locations[body.to];
        // Stock that lands where it cannot be sold is stock lost (M9). Only an outlet has a
        // menu to be on; the store and the kitchen carry whatever they are sent.
        if (to.type === "Outlet") {
          const menu = await productionRepo.menuAt(tx, body.to);
          assertRule(menu.has(body.it), `${item.n} is not listed at ${to.n} — add it to that menu first`);
        }

        const at = new Date();
        const no = await allocateTicket(tx, at);
        await lockBalances(tx, [{ loc: KITCHEN, it: body.it }]);
        const stock = await productionRepo.balancesAt(tx, KITCHEN, [body.it]);
        const held = await reservedAt(tx, KITCHEN, [body.it]);
        // What another ticket is already holding is not the kitchen's to promise again.
        const free = round3((stock[body.it] ?? 0) - (held[`${KITCHEN}:${body.it}`] ?? 0));
        assertRule(free >= body.qty, `Kitchen has only ${fq(free, item.u)} ${item.u} free to promise`);

        const ticket = await writeTicket(tx, {
          refType: "direct", refId: "Direct issue", from: KITCHEN, to: body.to,
          lines: [{ it: body.it, qty: body.qty }], by: claims.sub, at,
        }, no);

        // No history row: `document_history` carries requests, requisitions, purchase orders
        // and production orders (spec §16), and a direct issue is none of those.
        const changed = ["tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        return {
          result: ticket,
          changed: [...changed],
          message: `${ticket.id} issued — ${body.qty} ${item.n} reserved for ${to.n}`,
        };
      });
    },
  };
}
