// Production: everything the Central Kitchen does. The two ways it puts stock on a ticket both
// reserve and neither moves — approval authorises, the scan moves (CLAUDE.md), and `handover`
// is still what empties the shelf. The board's statuses move no stock at all. The batch is the
// exception and the reason this module touches the ledger: it is the one write in the system
// that creates stock, so it consumes the recipe and books the yield in a single postMoves call.
import type { z } from "zod";
import type { Batch, DistributeBodySchema, MakeBatchBodySchema, PordStatus, ProdOrder, Ticket, WriteResponse } from "@rch/contract";
import { bestBeforeAt, bestBeforeText, canTransition, fq, PROD_ORDER_TRANSITIONS, round3 } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateNumber } from "../../lib/ids.js";
import { lockBalances, postMoves, type Move } from "../../lib/ledger.js";
import { loadMaster } from "../../lib/master.js";
import { reservedAt } from "../../lib/reservations.js";
import { assertRule } from "../../lib/rules.js";
import { allocateTicket, writeTicket } from "../../lib/tickets.js";
import { iso } from "../../lib/time.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { productionRepo } from "./repo.js";

export type DistributeBody = z.infer<typeof DistributeBodySchema>;
export type MakeBatchBody = z.infer<typeof MakeBatchBodySchema>;
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
        // The name if the master has one, the key if it does not. A location deactivated after
        // the order was raised must not turn a refusal the kitchen can read into a 500.
        const toName = master.locations[o.fromLoc]?.n ?? o.fromLoc;
        // The table decides; the sentence only explains. PROD_ORDER_TRANSITIONS is the same
        // data the board's Dispatch button is drawn from (spec §5.1), so a stage the UI offers
        // and a stage the server accepts cannot drift apart. One order, one ticket: dispatching
        // twice would raise a second ticket for stock already promised, which is how half an
        // order ends up in two places — so the refusal names where that stock already went.
        assertRule(
          canTransition(PROD_ORDER_TRANSITIONS, o.status, "Dispatched"),
          o.status === "Declined"
            ? `${id} was declined — it cannot be dispatched`
            : `${id} has already gone out — it is on one ticket to ${toName}`,
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
          message: `${ticket.id} issued — all ${lines.length} item${lines.length === 1 ? "" : "s"} of ${id} reserved for ${toName}`,
        };
      });
    },

    /**
     * One press on the kitchen's board. The order row is read `for update` first, so two
     * screens pressing Accept together cannot both find it New and both sign for it.
     *
     * The table decides and the sentence only explains: PROD_ORDER_TRANSITIONS is the same
     * data the board draws its buttons from (spec §5.1). The sentence is this endpoint's own
     * rather than `assertTransition`'s "is already <status>", which would answer a New order
     * asked to jump to Ready with "is already new" — true of the wrong half of the sentence.
     */
    async setStatus(claims: AccessClaims, id: string, st: PordStatus): Promise<WriteResponse<ProdOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await productionRepo.head(tx, id);
        if (!o) throw new NotFoundError(`There is no production order ${id}.`);
        // Dispatch is a movement, not a word: it mints the ticket the outlet collects against
        // and reserves the stock behind it, so it has its own endpoint (spec §9.2).
        assertRule(st !== "Dispatched", `${id} goes out on a pick ticket — dispatch it from the order instead`);
        // And the way back is a movement too. The table has Dispatched -> Ready so a cancelled
        // ticket can put the order back on the board; taking that edge here would leave the
        // ticket live and holding stock for an order the board says is still cooking.
        assertRule(o.status !== "Dispatched", `${id} has already gone out — cancel its ticket to bring it back onto the board`);
        assertRule(
          canTransition(PROD_ORDER_TRANSITIONS, o.status, st),
          `${id} is ${o.status.toLowerCase()} — it cannot go straight to ${st.toLowerCase()}`,
        );

        const at = new Date();
        await productionRepo.setStatus(tx, id, st);
        const who = await productionRepo.userName(tx, claims.sub);
        await appendHistory(tx, "prod_order", id, st, who, at);

        const changed = ["pord"] as const;
        await emitChanged(tx, changed);
        return { result: await productionRepo.wire(tx, id), changed: [...changed], message: `${id} — ${st.toLowerCase()}` };
      });
    },

    /**
     * A batch: the one write in this system that creates stock, and therefore the one that must
     * not be able to create it out of nothing. The recipe comes out of the kitchen's raw
     * materials and the finished units go onto its rack in the same `postMoves` call, so there
     * is no instant at which the hospital's books show one without the other (C1).
     *
     * Ingredients go against what was **started**; only the units that came good reach the rack
     * (UA-14). A tray dropped is stock consumed and nothing produced, and the batch row is what
     * records the difference.
     *
     * Lock order, as everywhere: ids before balances (`lib/ledger.ts`'s header). One call takes
     * every cell this write will move — the ingredients, and the finished item when there is a
     * yield to book — so the `postMoves` below re-takes only locks this transaction already
     * holds. A make that locked the ingredients alone would reach for a fifth row while holding
     * four; one that locked the finished item with nothing to yield would create a balance row
     * it never moves, and a zero row reads as "this location carries the line" (M12, spec §16).
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
        // The kitchen's own switch, in the kitchen's own words. Read before the recipe so the
        // sentences arrive in the order the screen has always produced them.
        const off = await productionRepo.overrideAt(tx, KITCHEN, body.it);
        assertRule(!off, `${item.n} is switched off in the kitchen`);
        const recipe = master.recipes[body.it];
        assertRule(recipe, `${item.n} has no recipe — it cannot be produced`);

        const need = recipe.l.map(([g, per]) => ({ it: g, qty: round3(per * started) }));
        const at = new Date();
        const no = await allocateNumber(tx, "batch", at);
        // Every cell this write will move, and no others: the finished item joins only when
        // there is a yield to book, because `lockBalances` creates the row it locks.
        const cells = [
          ...need.map((n) => ({ loc: KITCHEN, it: n.it })),
          ...(made > 0 ? [{ loc: KITCHEN, it: body.it }] : []),
        ];
        await lockBalances(tx, cells);
        const keys = cells.map((c) => c.it);
        const onHand = await productionRepo.balancesAt(tx, KITCHEN, keys);
        const held = await reservedAt(tx, KITCHEN, keys);
        // What another ticket is holding is not the kitchen's to bake with, so the measure is
        // free to promise and not what is on the shelf.
        const free = (g: string) => round3((onHand[g] ?? 0) - (held[`${KITCHEN}:${g}`] ?? 0));
        /** The kitchen's own sentence for an ingredient that will not stretch — one helper for
         *  both the pre-check below and the post-lock invariant loop further down, so the two
         *  never drift into saying it two different ways. */
        const shortOf = (g: string, freeQty: number): string => {
          const ing = master.items[g];
          const unit = ing?.u ?? "nos";
          return `Kitchen is short of ${ing?.n ?? g} — ${fq(freeQty, unit)} ${unit} left`;
        };
        // The first in recipe order, which is the one the kitchen's own screen names. Written as
        // an `if` rather than `assertRule(!short, short ? … : "")`: a refusal sentence computed
        // on the success path is a blank toast waiting for someone to drop the ternary.
        const short = need.find((n) => free(n.it) < n.qty);
        if (short) assertRule(false, shortOf(short.it, free(short.it)));

        const moves: Move[] = need.map((n) => ({
          loc: KITCHEN, it: n.it, qty: -n.qty, kind: "production_consume", refType: "batch", refId: no.id, by: claims.sub, at,
        }));
        // A yield of nothing is not a movement. The batch row records the lost tray, and the
        // kitchen's shelf list is left exactly as it was — no row is created for a line the
        // kitchen has never carried.
        if (made > 0) {
          moves.push({ loc: KITCHEN, it: body.it, qty: made, kind: "production_yield", refType: "batch", refId: no.id, by: claims.sub, at });
        }
        await postMoves(tx, moves);

        // The cover check above already ran under these locks, so this cannot fire today. It is
        // the invariant §12 asks for on every negative-going move, and it is what catches the
        // next caller that reads a balance before locking it.
        const after = await productionRepo.balancesAt(tx, KITCHEN, need.map((n) => n.it));
        const heldAfter = await reservedAt(tx, KITCHEN, need.map((n) => n.it));
        for (const n of need) {
          const left = round3((after[n.it] ?? 0) - (heldAfter[`${KITCHEN}:${n.it}`] ?? 0));
          assertRule(left >= 0, shortOf(n.it, Math.max(0, round3(left + n.qty))));
        }

        const bb = bestBeforeAt(at, item.sl);
        const row = await productionRepo.insertBatch(tx, {
          id: no.id, itemKey: body.it, startedQty: started, madeQty: made, at, bestBefore: bb,
          note: body.note ?? null, byUser: claims.sub,
        });
        // The shape readers/documents.ts's readBatches produces, for the one batch just written —
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
            ? `${no.id} — ${started} ${item.n} made, best before ${text}`
            : `${no.id} — ${made} of ${started} ${item.n} yielded (${(((made - started) / started) * 100).toFixed(1)}%), best before ${text}`,
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
        // The destination is the caller's word, so it is looked up rather than assumed — a key
        // the schema accepts but the master no longer carries is a 404 the kitchen can read,
        // not a crash halfway through the write.
        const to = master.locations[body.to];
        if (!to) throw new NotFoundError(`There is no location ${body.to}.`);
        // The tray is already in the kitchen; sending it to the kitchen moves nothing and would
        // still mint a ticket and hold the stock against itself. The screen's own list of
        // destinations leaves the kitchen out, and so does the server.
        assertRule(body.to !== KITCHEN, "A tray cannot be distributed to the kitchen it came from — choose the store or an outlet");
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
