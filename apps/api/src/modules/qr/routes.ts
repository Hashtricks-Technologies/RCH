// Qr: QR ordering - the customer's four public routes, the counter's queue, the super admin's
// codes and hours, and the gateway's webhook (outside the manifest, below).
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { API_PREFIX, RAZORPAY_WEBHOOK_PATH, routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createQrService, type RequestMeta } from "./service.js";

/** Per minute, per pod, on top of the global limit: a phone reads the menu and polls its order
 *  often, and places and pays rarely. A hospital's guests share one address (the ward's Wi-Fi, a
 *  carrier's NAT), so the menu's budget is per address and generous, and the status poll's is per
 *  order and address - forty phones polling their own orders from one Wi-Fi never share one
 *  budget. What these stop is a script. */
const QR_RATE_LIMITS = { menu: 120, order: 10, verify: 20, status: 30 } as const;
const perMinute = (max: number, keyGenerator?: (req: FastifyRequest) => string) =>
  ({ config: { rateLimit: { max, timeWindow: "1 minute", ...(keyGenerator ? { keyGenerator } : {}) } } });
const perOrderAndIp = (req: FastifyRequest): string => `qr-order:${(req.params as { id?: string }).id ?? ""}|${req.ip}`;

const metaOf = (req: FastifyRequest): RequestMeta => ({
  requestId: req.id, ip: req.ip, device: String(req.headers["user-agent"] ?? "").slice(0, 512),
});
const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export default fp(async (app) => {
  const svc = createQrService({
    db: app.db, gateway: () => app.payments,
    config: { maxRupees: app.config.qr.maxRupees, ttlMin: app.config.qr.ttlMin, pendingPerIp: app.config.qr.pendingPerIp },
    nudge: () => app.qrWorker.nudge(),
  });

  // ---- the customer's side. Public: the phone has no token. An accepted place or verify is
  // audited by the service itself (`recordSystemEvent`); a refused one leaves nothing.
  mount(app, routes.publicQrMenu, async (req) => svc.menu(req.params.token), perMinute(QR_RATE_LIMITS.menu));
  mount(app, routes.createQrOrder, async (req) => svc.place(req.params.token, req.body, metaOf(req)), perMinute(QR_RATE_LIMITS.order));
  mount(app, routes.verifyQrPayment, async (req) => svc.verify(req.params.id, req.body, metaOf(req)), perMinute(QR_RATE_LIMITS.verify));
  // `?k=` is the order's secret; `plugins/logging.ts` scrubs it from every logged URL.
  mount(app, routes.publicQrOrder, async (req) => svc.publicOrder(req.params.id, req.query.k), perMinute(QR_RATE_LIMITS.status, perOrderAndIp));

  // ---- the counter's queue. A local role reads and moves its own outlet's; a role that works
  // for every outlet (`all_outlets`) any outlet's.
  mount(app, routes.qrOrders, async (req) => svc.queue(req.actor));
  mount(app, routes.setQrOrderStatus, async (req) => svc.setStatus(req.actor, req.params.id, req.body.to));
  mount(app, routes.setQrPause, async (req) => {
    if (!req.actor.wide) requireLoc(req, req.params.loc, "your own counter");
    return svc.setPause(req.user.sub, req.params.loc, req.body.paused);
  });
  // Hospital-wide, like the void it follows: whoever holds Void a bill.
  mount(app, routes.retryQrRefund, async (req) => svc.retryRefund(req.params.id));

  // ---- the super admin's codes and hours.
  mount(app, routes.adminQrCodes, async () => svc.adminCodes());
  mount(app, routes.createQrCode, async (req) => svc.createCode(req.body));
  mount(app, routes.updateQrCode, async (req) => svc.updateCode(req.params.id, req.body));
  mount(app, routes.regenerateQrCode, async (req) => svc.regenerateCode(req.params.id));
  mount(app, routes.setOrderHours, async (req) => svc.setHours(req.params.loc, req.body.days));

  // ---- the gateway's webhook: outside the manifest, like `/events` and an item's photo. It is
  // signed by the gateway rather than by a token, and the signature is over the raw bytes - so it
  // lives in a scope of its own whose JSON parser hands the handler the untouched buffer, and no
  // other route's body parsing changes. 401 on a signature that does not match, 400 on a body
  // that is not JSON, 415 (Fastify's own) on a content type other than application/json, 503
  // while the gateway is not configured or while a payment cannot be settled yet (the gateway did
  // not answer a capture, a Z is closing the register), 200 for everything else - an event the
  // API does not act on included - and a 5xx otherwise only when the database fails. Every 5xx is
  // a case the gateway should redeliver.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => { done(null, body); });
    scope.post(API_PREFIX + RAZORPAY_WEBHOOK_PATH, async (req) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return svc.webhook(raw, header(req, "x-razorpay-signature"), header(req, "x-razorpay-event-id"),
        { method: "POST", path: RAZORPAY_WEBHOOK_PATH, ...metaOf(req) });
    });
  });
}, { name: "module:qr", dependencies: ["auth", "rbac", "idempotency", "db", "payments", "qr-worker"] });
