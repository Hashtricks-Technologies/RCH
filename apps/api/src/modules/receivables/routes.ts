// Receivables: parse, service, reply. Nothing else.
//
// No `requireLoc` anywhere here, on purpose. The outlet manager is hospital-wide - their `loc`
// is a desk, not a scope - and an account is the hospital's, not an outlet's: the same doctor
// runs up a balance at the coffee shop and the restaurant, and a settlement clears both. The
// route's own `access: ["manager"]` is the whole of the gate.
//
// `GET /payer-terms` is not here: it is a read of a slice the snapshot carries, scoped the way
// the roster is, so it lives with the other snapshot reads (`modules/snapshot/routes.ts`).
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createReceivablesService } from "./service.js";

export default fp(async (app) => {
  const svc = createReceivablesService(app.db);
  mount(app, routes.setClassTerms, async (req) => svc.setClassTerms(req.user, req.params.cls, req.body));
  mount(app, routes.setPayerTerms, async (req) => svc.setPayerTerms(req.user, req.params, req.body));
  mount(app, routes.receivables, async (req) => svc.receivables(req.actor));
  mount(app, routes.settlements, async (req) => svc.settlements(req.actor));
  mount(app, routes.statement, async (req) => svc.statement(req.params));
  mount(app, routes.recordSettlement, async (req) => svc.record(req.user, req.body));
  mount(app, routes.voidSettlement, async (req) => svc.voidSettlement(req.user, req.params.id, req.body));
}, { name: "module:receivables", dependencies: ["auth", "rbac", "idempotency", "db"] });
