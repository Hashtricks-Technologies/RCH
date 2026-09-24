import fp from "fastify-plugin";
import type { Config } from "../config.js";
import { createRazorpayGateway, type PaymentGateway } from "../lib/payments.js";

declare module "fastify" { interface FastifyInstance { payments: PaymentGateway | null } }

/** `gateway` is supplied by a test that wants to own it (`src/test/fake-gateway.ts`) - `null`
 *  included, to prove the switched-off path; otherwise the config decides: the real gateway when
 *  all three keys are set, `null` when none are. */
export default fp<{ config: Config; gateway?: PaymentGateway | null }>(async (app, { config, gateway }) => {
  app.decorate("payments", gateway !== undefined ? gateway : config.razorpay ? createRazorpayGateway(config.razorpay) : null);
}, { name: "payments" });
