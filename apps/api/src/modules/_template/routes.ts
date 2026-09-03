// Copy this folder to start a module.
//
// Every server module has the same skeleton — routes.ts, service.ts, repo.ts,
// <name>.test.ts — enforced by scripts/check-boundaries.sh in CI (spec
// docs/superpowers/specs/2026-09-03-backend-design.md §5.1, "Every server module has the
// same skeleton"). This file is NOT registered in modules/index.ts: it exists to be copied,
// not run. See apps/api/src/modules/me/routes.ts for a real, minimal example.
//
// routes.ts: parse -> service -> reply, nothing else. A real module ends with one
// `mount(app, routes.<name>, handler)` call per endpoint (see apps/api/src/routes.ts for
// `mount`, and packages/contract/src/routes.ts for the manifest entry it reads). This
// template has no manifest entry of its own, so it wires nothing up.
import fp from "fastify-plugin";
import { createTemplateService } from "./service.js";

export default fp(async (app) => {
  const service = createTemplateService(app.db);
  app.log.debug({ module: "_template" }, "template module built; copy this folder, do not register it");
  await service.noop();
}, { name: "module:_template", dependencies: ["auth", "rbac", "idempotency", "db"] });
