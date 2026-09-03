import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createSnapshotService } from "./service.js";
export default fp(async (app) => {
  const svc = createSnapshotService(app.db);
  mount(app, routes.snapshot, async (req) => svc.snapshot(req.user));
}, { name: "module:snapshot", dependencies: ["auth", "rbac", "db"] });
