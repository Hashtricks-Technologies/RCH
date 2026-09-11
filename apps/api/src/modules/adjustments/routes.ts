// Adjustments: a write-off or a count-up as a document — parse, scope, service, reply.
//
// Scope is decided here because the request names its own location, and each of the three roles
// that hold stock answers for a different set of shelves:
//
//  · `store`   — every shelf there is, the rejected-goods one included. The central store is
//                where a consignment that was turned away actually sits, and destroying it or
//                sending it back to the vendor is the only way it ever leaves.
//  · `manager` — the outlets, and nothing else. A manager supervises the three shops; the
//                central store keeps its own books.
//  · `prod`    — the kitchen, through the same `requireLoc` every other kitchen write takes.
import fp from "fastify-plugin";
import { OUTLETS, routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { ForbiddenError } from "../../lib/errors.js";
import { requireLoc } from "../../plugins/rbac.js";
import type { Req } from "../../routes.js";
import { createAdjustmentsService } from "./service.js";

/** Location decides which rows, so this is a 403 — the role gate has already decided the route
 *  exists for all three. */
function scopeToRole(req: Req<typeof routes.createAdjustment>): void {
  const loc = req.body.loc;
  if (req.user.role === "store") return;
  if (req.user.role === "manager") {
    if (!OUTLETS.some((o) => o === loc)) {
      throw new ForbiddenError("You can only adjust stock at an outlet — the central store writes off its own shelves");
    }
    return;
  }
  requireLoc(req, loc, "the Central Kitchen");
}

export default fp(async (app) => {
  const svc = createAdjustmentsService(app.db);
  mount(app, routes.createAdjustment, async (req) => {
    scopeToRole(req);
    return svc.create(req.user, req.body);
  });
}, { name: "module:adjustments", dependencies: ["auth", "rbac", "idempotency", "db"] });
