// Shopasks: the flow — transaction, rules, moves, id. Compose the helpers in apps/api/src/lib/;
// domain rules belong in packages/domain. See modules/_template/service.ts.
//
// One shop asking another for stock it is holding. The shop being asked grants or declines —
// never the manager (spec §9.2). A grant reserves at the shop that holds the stock and raises
// the ticket the asker collects against, in the same transaction as the reservation.
import type { z } from "zod";
import type {
  AnswerShopAskBodySchema, DeclineShopAskBodySchema, ShopAsk, ShopAskBodySchema, ShopAskSentResultSchema, WriteResponse,
} from "@rch/contract";
import { fq, round3, SHOP_ASK_TRANSITIONS } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { lockBalances } from "../../lib/ledger.js";
import { loadMaster } from "../../lib/master.js";
import { reservedAt } from "../../lib/reservations.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import { allocateTicket, writeTicket } from "../../lib/tickets.js";
import { requireLocOf } from "../../plugins/rbac.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { shopAsksRepo } from "./repo.js";

export type ShopAskBody = z.infer<typeof ShopAskBodySchema>;
export type AnswerShopAskBody = z.infer<typeof AnswerShopAskBodySchema>;
export type DeclineShopAskBody = z.infer<typeof DeclineShopAskBodySchema>;
export type ShopAskSentResult = z.infer<typeof ShopAskSentResultSchema>;

export function createShopAsksService(db: Db) {
  return {
    /** Directly between the two shops: the asker's own counter is `from`, and only another
     *  outlet can be asked — never the central store, the kitchen, or the asker's own shop. */
    async ask(claims: AccessClaims, body: ShopAskBody): Promise<WriteResponse<ShopAsk>> {
      return withTransaction(db, async (tx) => {
        const from = claims.loc;
        assertRule(body.to !== from, "Pick a different shop");
        const master = await loadMaster(tx);
        assertRule(master.locations[body.to]?.type === "Outlet" && master.locations[from]?.type === "Outlet", "Only another shop can be asked directly");
        assertRule(body.qty > 0, "Enter a quantity");
        const item = master.items[body.it];
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);

        const at = new Date();
        const id = await allocateId(tx, "shop_ask", at);
        await shopAsksRepo.insert(tx, {
          id, fromLoc: from, toLoc: body.to, itemKey: body.it, qty: round3(body.qty),
          status: "Asked", byUser: claims.sub, at, note: body.note,
        });

        const changed = ["shopAsks"] as const;
        await emitChanged(tx, changed);
        return {
          result: await shopAsksRepo.wire(tx, id),
          changed: [...changed],
          message: `${id} sent to ${master.locations[body.to]!.n} — they decide, not the manager`,
        };
      });
    },

    /**
     * The shop being asked grants or declines — never the asker, never the manager. A grant
     * reserves at the shop that holds the stock and raises the ticket the asker collects
     * against, in one transaction, so a grant nobody can cover is refused rather than
     * half-written.
     */
    async answer(claims: AccessClaims, id: string, body: AnswerShopAskBody): Promise<WriteResponse<ShopAskSentResult>> {
      return withTransaction(db, async (tx) => {
        const a = await shopAsksRepo.head(tx, id);
        if (!a) throw new NotFoundError(`There is no shop ask ${id}.`);
        // The shop being asked is the one that decides — never the manager, never the asker.
        requireLocOf(claims, a.toLoc, "your own counter");
        assertTransition(SHOP_ASK_TRANSITIONS, a.status, "Sent", id);

        const master = await loadMaster(tx);
        const item = master.items[a.itemKey];
        if (!item) throw new NotFoundError(`There is no item ${a.itemKey}.`);
        // Spec §9.2: 0 < grant <= asked. The browser silently clamped a bigger number down to
        // the ask; the server says so instead, because a counter who typed 60 for a 6 meant
        // something, and sending 6 without a word is the wrong kind of helpful.
        assertRule(body.grant > 0, "Grant a quantity, or decline the ask");
        assertRule(body.grant <= a.qty, `${master.locations[a.fromLoc]!.n} asked for ${fq(a.qty, item.u)} ${item.u} — grant that or less`);
        const give = round3(body.grant);

        // Ids before balance rows (lib/ledger.ts's header).
        const at = new Date();
        const no = await allocateTicket(tx, at);
        await lockBalances(tx, [{ loc: a.toLoc, it: a.itemKey }]);
        const stock = await shopAsksRepo.balancesAt(tx, a.toLoc, [a.itemKey]);
        const held = await reservedAt(tx, a.toLoc, [a.itemKey]);
        const free = round3((stock[a.itemKey] ?? 0) - (held[`${a.toLoc}:${a.itemKey}`] ?? 0));
        assertRule(free >= give, `${master.locations[a.toLoc]!.n} has only ${fq(free, item.u)} ${item.u} free to send`);

        // The ask runs asker -> holder; the ticket runs back the other way.
        const ticket = await writeTicket(tx, { refType: "shop_ask", refId: id, from: a.toLoc, to: a.fromLoc, lines: [{ it: a.itemKey, qty: give }], by: claims.sub, at }, no);
        await shopAsksRepo.setAnswer(tx, id, { status: "Sent", grantedQty: give, ticketId: ticket.id });

        const changed = ["shopAsks", "tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        return {
          result: { ask: await shopAsksRepo.wire(tx, id), ticket },
          changed: [...changed],
          message: `${id} granted — ${ticket.id} issued for ${fq(give, item.u)} ${item.u} to ${master.locations[a.fromLoc]!.n}`,
        };
      });
    },

    /** The shop being asked can also say no — with a reason the asker can read. No ticket, no
     *  reservation: nothing moves and nothing is held. */
    async decline(claims: AccessClaims, id: string, body: DeclineShopAskBody): Promise<WriteResponse<ShopAsk>> {
      return withTransaction(db, async (tx) => {
        const a = await shopAsksRepo.head(tx, id);
        if (!a) throw new NotFoundError(`There is no shop ask ${id}.`);
        requireLocOf(claims, a.toLoc, "your own counter");
        assertRule(body.reason.trim().length > 0, "Give a reason — the other shop sees it");
        assertTransition(SHOP_ASK_TRANSITIONS, a.status, "Declined", id);

        await shopAsksRepo.setAnswer(tx, id, { status: "Declined", reason: body.reason.trim() });

        const changed = ["shopAsks"] as const;
        await emitChanged(tx, changed);
        return { result: await shopAsksRepo.wire(tx, id), changed: [...changed], message: `${id} declined` };
      });
    },
  };
}
