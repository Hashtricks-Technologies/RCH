// Production: everything the Central Kitchen does. The two ways it puts stock on a ticket both
// reserve and neither moves - approval authorises, the scan moves (CLAUDE.md), and `handover`
// is still what empties the shelf. The board's statuses move no stock at all. The batch is the
// exception and the reason this module touches the ledger: it books the kitchen's yield onto its
// rack, with the batch row as the document the new stock stands on.
import type { z } from "zod";
import { OUTLETS } from "@rch/contract";
import type { Batch, CreateProdOrderBodySchema, DistributeBodySchema, MakeBatchBodySchema, PordStatus, ProdOrder, Ticket, WriteResponse } from "@rch/contract";
import { bestBeforeAt, bestBeforeText, canTransition, dmy, fq, PROD_ORDER_TRANSITIONS, round3 } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId, allocateNumber } from "../../lib/ids.js";
import { lockBalances, postMoves } from "../../lib/ledger.js";
import { loadMaster } from "../../lib/master.js";
import { reservedAt } from "../../lib/reservations.js";
import { assertRule } from "../../lib/rules.js";
import { allocateTicket, writeTicket } from "../../lib/tickets.js";
import { iso } from "../../lib/time.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { productionRepo } from "./repo.js";

export type CreateProdOrderBody = z.infer<typeof CreateProdOrderBodySchema>;
export type DistributeBody = z.infer<typeof DistributeBodySchema>;
export type MakeBatchBody = z.infer<typeof MakeBatchBodySchema>;
export type DispatchResult = { order: ProdOrder; ticket: Ticket };

/** Both paths leave from the kitchen: the `prod` role has exactly one, and neither endpoint
 *  lets the caller name a source. Pinned here rather than read off the request. */
const KITCHEN = "kitchen";

export function createProductionService(db: Db) {
  return {
    // ---- prod-order raise ----
    /**
     * An outlet asking the kitchen to make something - the other end of the board, and the only
     * way an order gets onto it now that the seed is not.
     *
     * No document lock: this mints its own row, so there is nothing yet for a second writer to
     * be deciding. And **no `lockBalances`** - an order promises nothing off the kitchen's
     * shelves. It is `dispatch` that reserves, and `handover` that moves. The reasoning is the
     * goods-receipt rule read the other way round (`grn`'s `receive` takes no balance lock
     * because both its moves are positive): a write that neither reads a balance nor promises
     * against one has no cell to lock, and locking one would create a phantom "carried at zero"
     * row for a shelf this order never touches (M12).
     *
     * So the whole of it is: rules, then the id, then the document, then the trail.
     */
    async raise(claims: AccessClaims, body: CreateProdOrderBody): Promise<WriteResponse<ProdOrder>> {
      return withTransaction(db, async (tx) => {
        const master = await loadMaster(tx);
        // A counter's `from` was pinned to its token in routes.ts; the manager's is the body's,
        // and a manager supervises all three shops, so there is nothing for the server to guess.
        const from = body.from;
        assertRule(from, "Choose which outlet this order is for");
        const fromName = master.locations[from]?.n ?? from;
        // The kitchen cannot order from itself and the central store carries, it does not sell.
        // Only an outlet has a menu for the tray to land on (M9), which is the next rule down.
        assertRule(OUTLETS.includes(from), `${fromName} is not an outlet - a production order is raised for a counter`);

        // Fold a repeated item into one line before anything is checked, the way `dispatch`
        // does: two lines of one product would be made twice, dispatched twice and covered
        // twice, and the quantity the kitchen must read is the total.
        const folded = new Map<string, number>();
        for (const l of body.lines) folded.set(l.it, round3((folded.get(l.it) ?? 0) + l.qty));
        const lines = [...folded].map(([it, qty]) => ({ it, qty }));
        assertRule(lines.every((l) => l.qty > 0), "Enter a quantity on every line");
        assertRule(lines.length > 0, "Add at least one item to the order");

        // One read for the whole order, not one per line: the menu cannot change under a
        // transaction that has already begun, and a fifty-line order would otherwise be fifty
        // round trips on a single pg client (`lib/master.ts`'s note).
        const menu = await productionRepo.menuAt(tx, from);
        for (const l of lines) {
          const item = master.items[l.it];
          if (!item) throw new NotFoundError(`There is no item ${l.it}.`);
          // Finished goods only. A made-to-order item carries a menu listing, so it looks
          // orderable - but nothing downstream can fill it: `makeBatch` refuses to stock a
          // phantom shelf of it (C2), `distribute` refuses to send one, and `dispatch` therefore
          // has nothing to cover the line with. An order for one would sit on the board until
          // somebody declined it, so it is refused here, at the door, in the words the kitchen's
          // own two refusals already use.
          assertRule(item.t !== "MTO", `${item.n} is made to order at the counter - it is not ordered from the kitchen`);
          // Everything else on an outlet's menu is bought in and comes off the central store's
          // shelf - a request, not an order, and the sentence says which door to use.
          assertRule(item.t === "FG", `${item.n} is not made in the kitchen - raise a stock request for it instead`);
          // Stock that lands where it cannot be sold is stock lost (M9). `distribute`'s own
          // words, because it is the same refusal one step later in the same journey.
          assertRule(menu.has(l.it), `${item.n} is not listed at ${fromName} - add it to that menu first`);
        }

        const at = new Date();
        const id = await allocateId(tx, "prd", at);
        await productionRepo.insertOrder(tx, { id, fromLoc: from, byUser: claims.sub, at, status: "New", needBy: body.need ?? null, note: body.note });
        await productionRepo.insertLines(tx, id, lines);
        const who = await productionRepo.userName(tx, claims.sub);
        // "Raised" rather than "New": the trail records what somebody did, and the status column
        // beside it already says where the order stands. The seed writes the same word.
        await appendHistory(tx, "prod_order", id, "Raised", who, at);

        const changed = ["pord"] as const;
        await emitChanged(tx, changed);
        return {
          result: await productionRepo.wire(tx, id),
          changed: [...changed],
          message: `${id} raised for ${fromName} - ${lines.length} item${lines.length === 1 ? "" : "s"}${body.need ? `, needed by ${dmy(body.need)}` : ""}`,
        };
      });
    },

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
        // The name if the master has one, the key if it does not. A location deactivated after
        // the order was raised must not turn a refusal the kitchen can read into a 500.
        const toName = master.locations[o.fromLoc]?.n ?? o.fromLoc;
        // The table decides; the sentence only explains. PROD_ORDER_TRANSITIONS is the same
        // data the board's Dispatch button is drawn from, so a stage the UI offers
        // and a stage the server accepts cannot drift apart. One order, one ticket: dispatching
        // twice would raise a second ticket for stock already promised, which is how half an
        // order ends up in two places - so the refusal names where that stock already went.
        assertRule(
          canTransition(PROD_ORDER_TRANSITIONS, o.status, "Dispatched"),
          o.status === "Declined"
            ? `${id} was declined - it cannot be dispatched`
            : `${id} has already gone out - it is on one ticket to ${toName}`,
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
        assertRule(short.length === 0, `Nothing dispatched - the kitchen is short of ${short.map((l) => master.items[l.it]?.n ?? l.it).join(", ")}`);

        const ticket = await writeTicket(tx, { refType: "prod_order", refId: id, from: KITCHEN, to: o.fromLoc, lines, by: claims.sub, at }, no);
        await productionRepo.setStatus(tx, id, "Dispatched");
        const who = await productionRepo.userName(tx, claims.sub);
        await appendHistory(tx, "prod_order", id, "Dispatched", who, at);

        const changed = ["pord", "tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        return {
          result: { order: await productionRepo.wire(tx, id), ticket },
          changed: [...changed],
          message: `${ticket.id} issued - all ${lines.length} item${lines.length === 1 ? "" : "s"} of ${id} reserved for ${toName}`,
        };
      });
    },

    /**
     * One press on the kitchen's board. The order row is read `for update` first, so two
     * screens pressing Accept together cannot both find it New and both sign for it.
     *
     * The table decides and the sentence only explains: PROD_ORDER_TRANSITIONS is the same
     * data the board draws its buttons from. The sentence is this endpoint's own
     * rather than `assertTransition`'s "is already <status>", which would answer a New order
     * asked to jump to Ready with "is already new" - true of the wrong half of the sentence.
     */
    async setStatus(claims: AccessClaims, id: string, st: PordStatus): Promise<WriteResponse<ProdOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await productionRepo.head(tx, id);
        if (!o) throw new NotFoundError(`There is no production order ${id}.`);
        // Dispatch is a movement, not a word: it mints the ticket the outlet collects against
        // and reserves the stock behind it, so it has its own endpoint.
        assertRule(st !== "Dispatched", `${id} goes out on a pick ticket - dispatch it from the order instead`);
        // And the way back is a movement too. The table has Dispatched -> Ready so a cancelled
        // ticket can put the order back on the board; taking that edge here would leave the
        // ticket live and holding stock for an order the board says is still cooking.
        assertRule(o.status !== "Dispatched", `${id} has already gone out - cancel its ticket to bring it back onto the board`);
        assertRule(
          canTransition(PROD_ORDER_TRANSITIONS, o.status, st),
          `${id} is ${o.status.toLowerCase()} - it cannot go straight to ${st.toLowerCase()}`,
        );

        const at = new Date();
        await productionRepo.setStatus(tx, id, st);
        const who = await productionRepo.userName(tx, claims.sub);
        await appendHistory(tx, "prod_order", id, st, who, at);

        const changed = ["pord"] as const;
        await emitChanged(tx, changed);
        return { result: await productionRepo.wire(tx, id), changed: [...changed], message: `${id} - ${st.toLowerCase()}` };
      });
    },

    /**
     * A batch: the kitchen's record of finished goods it made. The batch row is the document
     * the new stock stands on, and the units that came good go onto the kitchen's rack in the
     * same transaction, with a best-before stamped from the item's shelf life.
     *
     * Only the units that came good reach the rack (UA-14); a tray dropped is a batch row with
     * nothing yielded, and the row is what records the difference.
     *
     * The only move is positive, so - like `grn.receive` - there is no `lockBalances` and no
     * re-read: nothing is promised against a balance that only goes up. A yield of nothing
     * posts no move at all, so no balance row is created for a line the kitchen never carried
     * (M12).
     */
    async makeBatch(claims: AccessClaims, body: MakeBatchBody): Promise<WriteResponse<Batch>> {
      return withTransaction(db, async (tx) => {
        const started = round3(body.started);
        assertRule(started > 0, "Enter a quantity to make");
        const made = round3(body.made ?? started);
        assertRule(made >= 0 && made <= started, `Yield cannot exceed the ${started} started`);

        const master = await loadMaster(tx);
        const item = master.items[body.it];
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);
        // The kitchen's own switch, in the kitchen's own words, before what kind of item it is.
        const off = await productionRepo.overrideAt(tx, KITCHEN, body.it);
        assertRule(!off, `${item.n} is switched off in the kitchen`);
        // A made-to-order item is made at the till when it is sold, not stocked ahead of a sale
        // (C2); it carries a menu listing, so it is the case worth naming in its own words.
        assertRule(item.t !== "MTO", `${item.n} is made to order at the counter - it is not batched`);
        assertRule(item.t === "FG", `${item.n} is not a finished good - only a finished good is batched`);

        const at = new Date();
        const no = await allocateNumber(tx, "batch", at);
        // A yield of nothing is not a movement. The batch row records the lost tray, and the
        // kitchen's shelf list is left exactly as it was - no row is created for a line the
        // kitchen has never carried.
        if (made > 0) {
          await postMoves(tx, [{ loc: KITCHEN, it: body.it, qty: made, kind: "production_yield", refType: "batch", refId: no.id, by: claims.sub, at }]);
        }

        const bb = bestBeforeAt(at, item.sl);
        const row = await productionRepo.insertBatch(tx, {
          id: no.id, itemKey: body.it, startedQty: started, madeQty: made, at, bestBefore: bb,
          note: body.note ?? null, byUser: claims.sub,
        });
        // The shape readers/documents.ts's readBatches produces, for the one batch just written -
        // including its treatment of the column: a null note has nothing to show and is left off,
        // but a note written as "" is still a note the kitchen typed, so it stays on the wire.
        const result: Batch = {
          id: row.id, it: row.itemKey, qty: row.startedQty, made: row.madeQty,
          at: iso(row.at), bb: iso(row.bestBefore), ...(row.note !== null ? { note: row.note } : {}),
        };

        const text = bestBeforeText(bb, at);
        const changed = ["batch", "stock"] as const;
        await emitChanged(tx, changed);
        return {
          result,
          changed: [...changed],
          message: made === started
            ? `${no.id} - ${started} ${item.n} made, best before ${text}`
            : `${no.id} - ${made} of ${started} ${item.n} yielded (${(((made - started) / started) * 100).toFixed(1)}%), best before ${text}`,
        };
      });
    },

    /**
     * A tray the kitchen decided to push out: no order behind it, so the ticket's reference is
     * the words "Direct issue" rather than a document id. Same lock order as a dispatch, same
     * promise - the stock is held at the kitchen and moves when the collector's scan lands.
     */
    async distribute(claims: AccessClaims, body: DistributeBody): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        assertRule(body.qty > 0, "Enter a quantity");
        const master = await loadMaster(tx);
        const item = master.items[body.it];
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);
        // A made-to-order item has nothing sitting on a kitchen shelf to send anywhere - it is
        // made at the till the moment it is sold (C2).
        assertRule(item.t !== "MTO", `${item.n} is made to order at the counter - it is not distributed`);
        // The destination is the caller's word, so it is looked up rather than assumed - a key
        // the schema accepts but the master no longer carries is a 404 the kitchen can read,
        // not a crash halfway through the write.
        const to = master.locations[body.to];
        if (!to) throw new NotFoundError(`There is no location ${body.to}.`);
        // The tray is already in the kitchen; sending it to the kitchen moves nothing and would
        // still mint a ticket and hold the stock against itself. The screen's own list of
        // destinations leaves the kitchen out, and so does the server.
        assertRule(body.to !== KITCHEN, "A tray cannot be distributed to the kitchen it came from - choose the store or an outlet");
        // Stock that lands where it cannot be sold is stock lost (M9). Only an outlet has a
        // menu to be on; the store and the kitchen carry whatever they are sent.
        if (to.type === "Outlet") {
          const menu = await productionRepo.menuAt(tx, body.to);
          assertRule(menu.has(body.it), `${item.n} is not listed at ${to.n} - add it to that menu first`);
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
        // and production orders, and a direct issue is none of those.
        const changed = ["tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        return {
          result: ticket,
          changed: [...changed],
          message: `${ticket.id} issued - ${body.qty} ${item.n} reserved for ${to.n}`,
        };
      });
    },
  };
}
