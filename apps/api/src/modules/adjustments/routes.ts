// Adjustments: a write-off or a count-up as a document - parse, scope, service, reply.
//
// Scope is decided here because the request names its own location, and each of the two roles
// that hold stock directly answers for a different set of shelves:
//
//  · `store` - the central store and the rejected-goods shelf. The central store is where a
//              consignment that was turned away actually sits, and destroying it or sending it
//              back to the vendor is the only way it ever leaves.
//  · `prod`  - the kitchen, through the same `requireLoc` every other kitchen write takes.
//
// Neither reaches the other's shelf. An outlet's own shelf is on nobody's list: it is adjusted
// only through `modules/adjustmentRequests` - the counter raises, the manager approves.
import fp from "fastify-plugin";
import { QUARANTINE, routes, STORE } from "@rch/contract";
import { mount } from "../../routes.js";
import { ForbiddenError } from "../../lib/errors.js";
import { requireLoc } from "../../plugins/rbac.js";
import type { Req } from "../../routes.js";
import { createAdjustmentsService } from "./service.js";

const STORE_SHELVES: ReadonlySet<string> = new Set([STORE, QUARANTINE]);

function scopeToRole(req: Req<typeof routes.createAdjustment>): void {
  if (req.user.role === "store") {
    if (!STORE_SHELVES.has(req.body.loc)) throw new ForbiddenError("You can only do this for the Central Store or quarantine.");
    return;
  }
  requireLoc(req, req.body.loc, "the Central Kitchen");
}

export default fp(async (app) => {
  const svc = createAdjustmentsService(app.db);
  mount(app, routes.createAdjustment, async (req) => {
    scopeToRole(req);
    return svc.create(req.user, req.body);
  });
}, { name: "module:adjustments", dependencies: ["auth", "rbac", "idempotency", "db"] });
