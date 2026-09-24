import fp from "fastify-plugin";
import { API_PREFIX, ITEM_IMAGE_PATH, routes } from "@rch/contract";
import { NotFoundError } from "../../lib/errors.js";
import { mount } from "../../routes.js";
import { createCatalogService } from "./service.js";

export default fp(async (app) => {
  const svc = createCatalogService(app.db, app.images);
  mount(app, routes.savePrice, async (req) => svc.savePrice(req.params.list, req.params.it, req.body.price));
  mount(app, routes.addMenuItem, async (req) => svc.addMenuItem(req.params.loc, req.body.it));
  mount(app, routes.removeMenuItem, async (req) => svc.removeMenuItem(req.params.loc, req.params.it));
  // The item master's own module: a price, a menu line, and - from Phase 5 - a new line on it.
  mount(app, routes.createItem, async (req) => svc.createItem(req.user, req.body));
  // ---- item patch ----
  // And the way back: an existing line edited or retired. Which fields the caller's own role may
  // move is the service's rule, from `ITEM_FIELD_FEATURES` - the manifest opens the door to
  // either half (Items & stock, Item master), and each reads a sentence when it reaches for the
  // other's box.
  mount(app, routes.patchItem, async (req) => svc.patchItem(req.actor, req.params.it, req.body));
  // ---- item photos ----
  mount(app, routes.setItemImage, async (req) => svc.setItemImage(req.actor, req.params.it, req.body.data));
  mount(app, routes.removeItemImage, async (req) => svc.removeItemImage(req.actor, req.params.it));
  // The photo itself. Outside the manifest the way `/events` is (`ITEM_IMAGE_PATH`): an `<img>`
  // sends no bearer token, and the answer is bytes, not JSON. It serves only the hash the item
  // points at now, so a replaced photo is gone the moment the write commits, and the hash in the
  // URL is what lets the browser keep it for a year.
  app.get<{ Params: { it: string; hash: string } }>(API_PREFIX + ITEM_IMAGE_PATH, async (req, reply) => {
    const r = await svc.readItemImage(req.params.it, req.params.hash);
    if (!r.found) {
      if (r.missingObject) req.log.error({ it: req.params.it, hash: req.params.hash }, "an item's photo row points at an object the image store does not have");
      throw new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
    }
    return reply
      .header("content-type", r.photo.contentType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'")
      .send(Buffer.from(r.photo.bytes));
  });
}, { name: "module:catalog", dependencies: ["auth", "rbac", "idempotency", "db", "images"] });
