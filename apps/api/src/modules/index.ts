import type { App } from "../app.js";
import auth from "./auth/routes.js";
import me from "./me/routes.js";
import master from "./master/routes.js";
import snapshot from "./snapshot/routes.js";
import pos from "./pos/routes.js";
import availability from "./availability/routes.js";
import catalog from "./catalog/routes.js";
import requests from "./requests/routes.js";
import tickets from "./tickets/routes.js";
import shopasks from "./shopasks/routes.js";
import production from "./production/routes.js";

/** Every module, registered in one place. Adding a module = one import + one line here. */
export async function registerModules(app: App): Promise<void> {
  await app.register(auth);
  await app.register(me);
  await app.register(master);
  await app.register(snapshot);
  await app.register(pos);
  await app.register(availability);
  await app.register(catalog);
  await app.register(requests);
  await app.register(tickets);
  await app.register(shopasks);
  await app.register(production);
}
