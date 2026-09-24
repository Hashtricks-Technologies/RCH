import fp from "fastify-plugin";
import type { Config } from "../config.js";
import { createQrService } from "../modules/qr/service.js";
import { createQrWorker, type TickOptions, type TickResult } from "../modules/qr/worker.js";

declare module "fastify" {
  interface FastifyInstance {
    qrWorker: {
      /** One pass: expire unpaid orders, reconcile with the gateway (every couple of minutes, or
       *  as `opts` says), send due refunds. Passes never overlap within a process - a call while
       *  one runs waits for it and answers with its result. Across pods the row locks' `skip
       *  locked` keeps them apart. */
      tick(now?: Date, opts?: TickOptions): Promise<TickResult>;
      /** Run a pass soon, after a commit that queued a refund. Nothing when the worker is off. */
      nudge(): void;
    };
  }
}

/**
 * The QR worker (`modules/qr/worker.ts`), on a timer: every `QR_WORKER_INTERVAL_MS` (30 s by
 * default), and at once when nudged. `0` switches the timer and the nudges off - the tests do,
 * and call `tick` themselves. On close the timer stops and a pass in flight is awaited, so a
 * shutdown never cuts a refund's record off between the gateway's answer and its commit.
 */
export default fp<{ config: Config }>(async (app, { config }) => {
  // The worker settles what it reconciles through the same service the routes use. Its nudge is
  // a no-op: a refund the reconcile queues is sent later in the same pass.
  const settler = createQrService({
    db: app.db, gateway: () => app.payments,
    config: { maxRupees: config.qr.maxRupees, ttlMin: config.qr.ttlMin }, nudge: () => undefined,
  });
  const worker = createQrWorker(app.db, () => app.payments, app.log, settler);
  const every = config.qr.workerIntervalMs;
  let running: Promise<TickResult> | null = null;
  let closed = false;
  const tick = (now?: Date, opts?: TickOptions): Promise<TickResult> => {
    running ??= worker.tick(now, opts).finally(() => { running = null; });
    return running;
  };
  const background = () => {
    if (closed) return;
    tick().catch((err: unknown) => { app.log.error({ err }, "qr worker pass failed"); });
  };
  const timer = every > 0 ? setInterval(background, every) : null;
  timer?.unref();
  app.decorate("qrWorker", { tick, nudge: () => { if (every > 0) setImmediate(background); } });
  app.addHook("onClose", async () => {
    closed = true;
    if (timer) clearInterval(timer);
    await running?.catch(() => undefined);
  });
}, { name: "qr-worker", dependencies: ["db", "payments"] });
