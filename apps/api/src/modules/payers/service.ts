// Payers: the flow — transaction, rules. Composes the helpers in apps/api/src/lib/. Master
// data, like vendors: a payer is never deleted, because the bills already posted to them have
// to stay readable, and there is no `document_history` trail — this is a register, not a
// document. There is no `allocateId` either: the id is the hospital's own number, read off a
// wristband or a payroll record, and a number the till invented would be an account nobody can
// settle. The three rosters are numbered independently, so `(kind, id)` is the key throughout.
import type { z } from "zod";
import type { PatchPayerBodySchema, PayerBodySchema, PayerKind, PayerRecord, WriteResponse } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { assertRule } from "../../lib/rules.js";
import { PAYER_LABEL } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { payersRepo, type PayerPatch, type PayerRow } from "./repo.js";

export type PayerBody = z.infer<typeof PayerBodySchema>;
export type PatchPayerBody = z.infer<typeof PatchPayerBodySchema>;

const toWire = (row: PayerRow): PayerRecord => ({ kind: row.kind, id: row.id, name: row.name, active: row.active });

export function createPayersService(db: Db) {
  return {
    async create(_claims: AccessClaims, body: PayerBody): Promise<WriteResponse<PayerRecord>> {
      return withTransaction(db, async (tx) => {
        const label = PAYER_LABEL[body.kind];
        const id = body.id.trim();
        const name = body.name.trim();
        assertRule(id.length > 0, `Give the ${label} an id before saving`);
        assertRule(name.length > 0, `Give the ${label} a name before saving`);

        // The pre-check gives the sentence; the insert is the arbiter. Both say the same thing,
        // so a caller that lost the race reads what the check would have told it a moment later.
        const taken = await payersRepo.head(tx, body.kind, id);
        assertRule(!taken, `${id} is already on the ${label} roster`);

        const row = await payersRepo.insertIfNew(tx, { kind: body.kind, id, name, active: true });
        assertRule(row, `${id} is already on the ${label} roster`);

        const changed = ["roster"] as const;
        await emitChanged(tx, changed);
        return { result: toWire(row), changed: [...changed], message: `${name} added to the ${label} roster as ${id}` };
      });
    },

    /** One PATCH covers the rename and the on/off switch, the way `updateVendor` does: a patch
     *  whose only key is `active` gets one of the two switch sentences, anything else gets
     *  `<name> updated`. Deactivating is the only way off the roster — a payer with bills
     *  against them cannot be deleted without taking the bills' own account with them. */
    async patch(_claims: AccessClaims, kind: PayerKind, id: string, body: PatchPayerBody): Promise<WriteResponse<PayerRecord>> {
      return withTransaction(db, async (tx) => {
        const label = PAYER_LABEL[kind];
        // Word for word the sentence the till reads when a bill names a payer the roster has
        // never heard of (`pos`'s own refusal, through the same `PAYER_LABEL`): one register,
        // one wording, whichever screen the operator is standing at.
        const existing = await payersRepo.head(tx, kind, id);
        if (!existing) throw new NotFoundError(`There is no ${label} ${id} on the roster.`);

        const keys = Object.keys(body) as (keyof PatchPayerBody)[];
        assertRule(keys.length > 0, `Nothing to change on ${id}`);
        if (body.name !== undefined) assertRule(body.name.trim().length > 0, `Give the ${label} a name before saving`);

        const patch: PayerPatch = {};
        if (body.name !== undefined) patch.name = body.name.trim();
        if (body.active !== undefined) patch.active = body.active;

        const row = await payersRepo.update(tx, kind, id, patch);

        const changed = ["roster"] as const;
        await emitChanged(tx, changed);
        const onlyActive = keys.length === 1 && keys[0] === "active";
        const message = onlyActive
          ? (body.active
            ? `${row.name} is active again and can be billed to`
            : `${row.name} deactivated — bills already posted to them stay, new ones cannot`)
          : `${row.name} updated`;
        return { result: toWire(row), changed: [...changed], message };
      });
    },
  };
}
