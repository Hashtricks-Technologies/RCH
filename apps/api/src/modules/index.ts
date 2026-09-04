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
import requisitions from "./requisitions/routes.js";
import purchaseorders from "./purchaseorders/routes.js";
import grn from "./grn/routes.js";
import vendors from "./vendors/routes.js";
import contracts from "./contracts/routes.js";
import productreqs from "./productreqs/routes.js";

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
  await app.register(requisitions);
  await app.register(purchaseorders);
  await app.register(grn);
  await app.register(vendors);
  await app.register(contracts);
  await app.register(productreqs);
}
