// Shifts: the counter operator's live report, their Close Shift, and the list of closed shifts -
// parse, service, reply.
//
// No `requireLoc` here: none of the three names a location. The live report and the close are
// the caller's own shift at the counter their session stands at (`claims.loc`), and the list is
// scoped by role inside the service - a manager reads every outlet's, a counter only their own.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createShiftsService } from "./service.js";

export default fp(async (app) => {
  const svc = createShiftsService(app.db);
  mount(app, routes.currentShift, async (req) => svc.current(req.user));
  mount(app, routes.closeShift, async (req) => svc.close(req.user));
  mount(app, routes.shifts, async (req) => svc.list(req.user, req.query));
}, { name: "module:shifts", dependencies: ["auth", "rbac", "idempotency", "db"] });
