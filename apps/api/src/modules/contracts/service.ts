// Rate contracts: the flow — transaction, rules, ids. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a decision lives in packages/domain. A contract is
// never deleted: it is closed so a purchase order it priced months ago stays readable.
import type { z } from "zod";
import type { ContractBodySchema, PatchContractBodySchema, RateContract, WriteResponse } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { loadItems } from "../../lib/master.js";
import { assertRule } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { contractsRepo, type RateContractPatch } from "./repo.js";

export type ContractBody = z.infer<typeof ContractBodySchema>;
export type PatchContractBody = z.infer<typeof PatchContractBodySchema>;

const liveClashMessage = (itemName: string, vendorName: string) => `${itemName} already has a live contract with ${vendorName}`;

export function createContractsService(db: Db) {
  return {
    async create(_claims: AccessClaims, body: ContractBody): Promise<WriteResponse<RateContract>> {
      return withTransaction(db, async (tx) => {
        const vendor = await contractsRepo.vendorHead(tx, body.vendorId);
        if (!vendor) throw new NotFoundError(`There is no vendor ${body.vendorId}.`);
        const item = (await loadItems(tx))[body.it];
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);
        assertRule(body.to >= body.from, "A contract cannot end before it starts");
        assertRule(body.rate > 0, "A contract rate must be more than zero");

        const at = new Date();
        const id = await allocateId(tx, "contract", at);
        // The pre-checks ran above; the insert is the arbiter (`rate_contracts_live_uq`). Two
        // callers can both pass them, but only one gets a row back.
        const row = await contractsRepo.insertIfNew(tx, {
          id, vendorId: body.vendorId, itemKey: body.it, rate: body.rate,
          validFrom: body.from, validTo: body.to, moq: body.moq, active: true,
        });
        assertRule(row, liveClashMessage(item.n, vendor.name));

        const changed = ["contracts"] as const;
        await emitChanged(tx, changed);
        return {
          result: await contractsRepo.wire(tx, id),
          changed: [...changed],
          message: `${id} — ${item.n} at ₹${body.rate} with ${vendor.name}`,
        };
      });
    },

    async patch(_claims: AccessClaims, id: string, body: PatchContractBody): Promise<WriteResponse<RateContract>> {
      return withTransaction(db, async (tx) => {
        const existing = await contractsRepo.head(tx, id);
        if (!existing) throw new NotFoundError(`There is no rate contract ${id}.`);
        assertRule(Object.keys(body).length > 0, `Nothing to change on ${id}`);

        const from = body.from ?? existing.validFrom;
        const to = body.to ?? existing.validTo;
        assertRule(to >= from, "A contract cannot end before it starts");
        if (body.rate !== undefined) assertRule(body.rate > 0, "A contract rate must be more than zero");

        // Reactivating one is refused when another live contract already covers this vendor
        // and item — the index is the arbiter for the race two such reactivations can run;
        // this pre-check is what turns the ordinary case into the store's own sentence. The
        // display names are read once, here, rather than again after a failed update: a unique
        // violation aborts the whole Postgres transaction, so a second query issued against
        // `tx` after catching one — even a plain read — would itself fail with "current
        // transaction is aborted", turning the intended 422 into a 500.
        const willBeActive = body.active ?? existing.active;
        const reactivating = willBeActive && !existing.active;
        let clashMessage: string | undefined;
        if (reactivating) {
          const vendor = await contractsRepo.vendorHead(tx, existing.vendorId);
          const item = (await loadItems(tx))[existing.itemKey];
          clashMessage = liveClashMessage(item?.n ?? existing.itemKey, vendor?.name ?? existing.vendorId);
          const clash = await contractsRepo.liveFor(tx, existing.vendorId, existing.itemKey, id);
          assertRule(!clash, clashMessage);
        }

        const patch: RateContractPatch = {};
        if (body.rate !== undefined) patch.rate = body.rate;
        if (body.from !== undefined) patch.validFrom = body.from;
        if (body.to !== undefined) patch.validTo = body.to;
        if (body.moq !== undefined) patch.moq = body.moq;
        if (body.active !== undefined) patch.active = body.active;
        // The pre-check above catches the ordinary case; this is the backstop for the race it
        // cannot see — two reactivations of two closed contracts for the same pair, neither
        // holding a lock the other would find. `update` returns `undefined` on exactly that
        // collision (`rate_contracts_live_uq`), and the loser reads the pre-check's own
        // sentence, already in hand from before the update ran.
        const row = await contractsRepo.update(tx, id, patch);
        if (!row) assertRule(false, clashMessage!);

        const changed = ["contracts"] as const;
        await emitChanged(tx, changed);
        return { result: await contractsRepo.wire(tx, id), changed: [...changed], message: `${id} updated` };
      });
    },

    /** A soft delete (spec §9.2): the contract stays on record, it just no longer prices an
     *  order. `patch(id, { active: true })` reopens it, subject to the same live-pair rule. */
    async remove(_claims: AccessClaims, id: string): Promise<WriteResponse<RateContract>> {
      return withTransaction(db, async (tx) => {
        const existing = await contractsRepo.head(tx, id);
        if (!existing) throw new NotFoundError(`There is no rate contract ${id}.`);
        await contractsRepo.update(tx, id, { active: false });

        const changed = ["contracts"] as const;
        await emitChanged(tx, changed);
        return {
          result: await contractsRepo.wire(tx, id),
          changed: [...changed],
          message: `${id} closed — it stays on record but no longer prices an order`,
        };
      });
    },
  };
}
