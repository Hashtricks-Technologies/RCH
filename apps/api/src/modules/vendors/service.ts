// Vendors: the flow — transaction, rules, ids. Composes the helpers in apps/api/src/lib/;
// the arithmetic of a decision lives in packages/domain. A vendor is never deleted: it is
// deactivated so a purchase order raised against it months ago stays readable.
import type { z } from "zod";
import type { PatchVendorBodySchema, Vendor, VendorBodySchema, WriteResponse } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { assertRule } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { vendorsRepo, type VendorPatch, type VendorRow } from "./repo.js";

export type VendorBody = z.infer<typeof VendorBodySchema>;
export type PatchVendorBody = z.infer<typeof PatchVendorBodySchema>;

/** Two state digits, a ten-character PAN, an entity number, a literal Z, and a check character.
 *  Format only: this is not a checksum and does not prove the number is registered. Module-local
 *  — a validation of one field on one endpoint, with no second consumer (spec §5.1's rule is
 *  about rules two sides enforce; `VendorDrawer.tsx` gains a hint, not a rule — Task 10). */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const GSTIN_MESSAGE = "That is not a GSTIN — 15 characters, like 33AAACA1234F1Z5";
/** Checked and stored the same way: upper-cased first, so a lowercase entry that passes the
 *  check is not the row a later read finds — the format the regex names is what lands. */
const normaliseGstin = (gstin: string): string => gstin.toUpperCase();
const assertGstin = (gstin: string): void => assertRule(!gstin || GSTIN_RE.test(gstin), GSTIN_MESSAGE);

const toWire = (row: VendorRow): Vendor => ({
  id: row.id, n: row.name, gstin: row.gstin, contact: row.contact, ph: row.phone,
  terms: row.terms, lead: row.leadDays, groups: row.groups, active: row.active,
});

export function createVendorsService(db: Db) {
  return {
    async create(_claims: AccessClaims, body: VendorBody): Promise<WriteResponse<Vendor>> {
      return withTransaction(db, async (tx) => {
        const name = body.n.trim();
        assertRule(name.length > 0, "Give the vendor a name before saving");
        const gstin = normaliseGstin(body.gstin.trim());
        assertGstin(gstin);

        const id = await allocateId(tx, "vendor");
        // The pre-check ran above; the insert is the arbiter (`vendors_name_ci_uq`). Two
        // callers can both pass the trim/GSTIN checks, but only one gets a row back.
        const row = await vendorsRepo.insertIfNew(tx, {
          id, name, gstin, contact: body.contact.trim(), phone: body.ph.trim(),
          terms: body.terms.trim(), leadDays: body.lead, groups: body.groups, active: true,
        });
        assertRule(row, `${name} is already on the vendor list`);

        const changed = ["vendors"] as const;
        await emitChanged(tx, changed);
        return { result: toWire(row), changed: [...changed], message: `${name} added as ${id}` };
      });
    },

    /** `setVendorActive` and `updateVendor` are one endpoint: a patch whose only key is
     *  `active` gets one of the two on/off sentences, anything else gets `<name> updated`. */
    async patch(_claims: AccessClaims, id: string, body: PatchVendorBody): Promise<WriteResponse<Vendor>> {
      return withTransaction(db, async (tx) => {
        const existing = await vendorsRepo.head(tx, id);
        if (!existing) throw new NotFoundError(`There is no vendor ${id}.`);

        const keys = Object.keys(body) as (keyof PatchVendorBody)[];
        assertRule(keys.length > 0, `Nothing to change on ${id}`);

        if (body.n !== undefined) assertRule(body.n.trim().length > 0, "Give the vendor a name before saving");
        const gstin = body.gstin === undefined ? undefined : normaliseGstin(body.gstin.trim());
        if (gstin !== undefined) assertGstin(gstin);

        const patch: VendorPatch = {};
        if (body.n !== undefined) patch.name = body.n.trim();
        if (gstin !== undefined) patch.gstin = gstin;
        if (body.contact !== undefined) patch.contact = body.contact.trim();
        if (body.ph !== undefined) patch.phone = body.ph.trim();
        if (body.terms !== undefined) patch.terms = body.terms.trim();
        if (body.lead !== undefined) patch.leadDays = body.lead;
        if (body.groups !== undefined) patch.groups = body.groups;
        if (body.active !== undefined) patch.active = body.active;

        // The trim/GSTIN checks ran above; the update is the arbiter for the name (`update`
        // catches `vendors_name_ci_uq` the way `insertIfNew` catches it on a create).
        const row = await vendorsRepo.update(tx, id, patch);
        assertRule(row, `${(body.n ?? existing.name).trim()} is already on the vendor list`);

        const changed = ["vendors"] as const;
        await emitChanged(tx, changed);
        const onlyActive = keys.length === 1 && keys[0] === "active";
        const message = onlyActive
          ? (body.active
            ? `${row.name} is active again and can be picked on new orders`
            : `${row.name} deactivated — existing orders keep it, new drafts cannot pick it`)
          : `${row.name} updated`;
        return { result: toWire(row), changed: [...changed], message };
      });
    },
  };
}
