// Product requests: the flow - transaction, rules, ids. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a decision lives in packages/domain.
//
// A shop's ask for something not on the master, and the central store's answer to it. Neither
// write moves stock or appends history - `product_requests` is not one of the four document
// types that write `document_history`, and this phase does not change that.
import type { z } from "zod";
import { OUTLETS, type AnswerProductRequestBodySchema, type CreateProductRequestBodySchema, type ProductRequest, type WriteResponse } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { loadLocations } from "../../lib/master.js";
import { assertRule } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { productReqsRepo } from "./repo.js";

export type CreateProductRequestBody = z.infer<typeof CreateProductRequestBodySchema>;
export type AnswerProductRequestBody = z.infer<typeof AnswerProductRequestBodySchema>;

export function createProductReqsService(db: Db) {
  return {
    /** A shop's ask, sent to the central store - it does nothing to the master by itself. */
    async create(claims: AccessClaims, body: CreateProductRequestBody): Promise<WriteResponse<ProductRequest>> {
      return withTransaction(db, async (tx) => {
        const name = body.name.trim();
        assertRule(name.length > 0, "Name the product you want added");
        // A counter's own location was already checked against its token in routes.ts. A manager
        // may ask for any of the outlets they look after, but the central store and the kitchen
        // are not shops and have no menu to add a product to - the same sentence `availability`
        // gives a manager reaching past the outlets.
        if (claims.role === "manager") {
          const loc = (await loadLocations(tx))[body.forLoc];
          assertRule(OUTLETS.includes(body.forLoc), `${loc?.n ?? body.forLoc} is not an outlet`);
        }

        const at = new Date();
        const id = await allocateId(tx, "product_req", at);
        await productReqsRepo.insert(tx, { id, name, why: body.why.trim(), forLoc: body.forLoc, byUser: claims.sub, at, status: "Requested" });

        const changed = ["productReqs"] as const;
        await emitChanged(tx, changed);
        return { result: await productReqsRepo.wire(tx, id), changed: [...changed], message: `${id} sent to the central store - they add it to the master` };
      });
    },

    /**
     * The central store's decision. Marking one `Created` needs the catalogue item it became -
     * `POST /items` is the only way to get one - because that link is the whole point of asking.
     *
     * `_claims` is the answering desk, and nothing is written with it: `product_requests` has
     * `by_user` for the shop that asked and no column at all for who answered, and this module
     * writes no `document_history` either (see the header). It is on the signature because the
     * decision belongs to a person, and the day a column exists this is where it comes from -
     * the underscore is only there because `noUnusedParameters` is on.
     */
    async answer(_claims: AccessClaims, id: string, body: AnswerProductRequestBody): Promise<WriteResponse<ProductRequest>> {
      return withTransaction(db, async (tx) => {
        const p = await productReqsRepo.head(tx, id);
        if (!p) throw new NotFoundError(`There is no product request ${id}.`);
        assertRule(p.status === "Requested", `${id} has already been answered`);

        if (body.st === "Created") {
          assertRule(body.itemKey, "Pick the catalogue item this request became");
          const exists = await productReqsRepo.itemExists(tx, body.itemKey);
          if (!exists) throw new NotFoundError(`There is no item ${body.itemKey}.`);
        }
        await productReqsRepo.setAnswer(tx, id, { status: body.st, note: body.note.trim(), itemKey: body.st === "Created" ? body.itemKey : undefined });

        const changed = ["productReqs"] as const;
        await emitChanged(tx, changed);
        return {
          result: await productReqsRepo.wire(tx, id), changed: [...changed],
          message: body.st === "Created" ? `${id} - product created on the master` : `${id} declined`,
        };
      });
    },
  };
}
