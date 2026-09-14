import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createRecipesService } from "./service.js";

// The recipe book's one write. The kitchen in-charge keeps the recipes it makes from, and the
// outlet manager - who owns an item's cost and every price list priced against it - keeps them
// too; neither is location-scoped, because a recipe is master data, not something done at a
// place. `GET /recipes` stays in `master`, beside the other master reads.
export default fp(async (app) => {
  const svc = createRecipesService(app.db);
  mount(app, routes.saveRecipe, async (req) => svc.save(req.user, req.params.it, req.body));
}, { name: "module:recipes", dependencies: ["auth", "rbac", "idempotency", "db"] });
