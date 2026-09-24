import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QrRefundSchema } from "@rch/contract";
import type { App } from "../app.js";
import { buildTestApp } from "../test/app.js";
import { given } from "../test/builders.js";
import { seedTestDb } from "../test/seed.js";
import { withTransaction } from "./db.js";
import { deferRefund, moveRefund, queueRefund, REFUND_BACKOFF_MS, REFUND_MAX_ATTEMPTS, refundsOfOrder, toWireRefund } from "./refunds.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "refunds" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

const order = () => given.qrOrder(app.db, { loc: "coffee", st: "Paid", rzpPaymentId: `pay_${Math.random().toString(36).slice(2)}`, lines: [{ it: "juice", qty: 1, rate: 20 }] });
const tx = <T>(fn: Parameters<typeof withTransaction<T>>[1]) => withTransaction(app.db, fn);

describe("queueRefund", () => {
  it("numbers each refund after its order, pending and due at once", async () => {
    const qo = await order();
    const at = new Date("2026-09-24T10:00:00Z");
    const first = await tx((t) => queueRefund(t, { qrOrderId: qo, paymentId: "pay_1", amount: 20, reason: "void", billNo: null, at }));
    const second = await tx((t) => queueRefund(t, { qrOrderId: qo, paymentId: "pay_2", amount: 20, reason: "duplicate" }));
    expect(first).toMatchObject({ id: `${qo}-R1`, status: "Pending", attempts: 0, amount: 20, reason: "void", nextAttemptAt: at, lastError: null });
    expect(second.id).toBe(`${qo}-R2`);
    expect((await refundsOfOrder(app.db, qo)).map((r) => r.id)).toEqual([`${qo}-R1`, `${qo}-R2`]);
    expect(QrRefundSchema.safeParse(toWireRefund(first)).success).toBe(true);
    expect(toWireRefund(first)).toEqual({ id: `${qo}-R1`, status: "Pending", reason: "void", amount: 20, attempts: 0 });
  });
  it("refuses nothing to refund", async () => {
    const qo = await order();
    await expect(tx((t) => queueRefund(t, { qrOrderId: qo, paymentId: "pay_1", amount: 0, reason: "void" }))).rejects.toMatchObject({ cause: { constraint: "payment_refunds_amount_ck" } });
  });
});

describe("moving a refund", () => {
  it("walks Pending, Sent, Processed, and refuses any other move in words", async () => {
    const qo = await order();
    const r = await tx((t) => queueRefund(t, { qrOrderId: qo, paymentId: "pay_1", amount: 20, reason: "unfulfillable" }));
    await expect(tx((t) => moveRefund(t, r.id, "Processed"))).rejects.toThrow(`Refund ${r.id} is already pending`);
    const sent = await tx((t) => moveRefund(t, r.id, "Sent", { rzpRefundId: "rfnd_1" }));
    expect(sent).toMatchObject({ status: "Sent", rzpRefundId: "rfnd_1", processedAt: null });
    const done = await tx((t) => moveRefund(t, r.id, "Processed"));
    expect(done.status).toBe("Processed");
    expect(done.processedAt).toBeInstanceOf(Date);
    await expect(tx((t) => moveRefund(t, r.id, "Pending"))).rejects.toThrow(`Refund ${r.id} is already processed`);
    await expect(tx((t) => moveRefund(t, `${qo}-R9`, "Sent"))).rejects.toThrow(`There is no refund ${qo}-R9.`);
  });
  it("backs off after each failed send, fails on the last, and a retry starts it again from nothing", async () => {
    const qo = await order();
    const r = await tx((t) => queueRefund(t, { qrOrderId: qo, paymentId: "pay_1", amount: 20, reason: "void" }));
    const at = new Date("2026-09-24T10:00:00Z");
    for (let i = 0; i < REFUND_BACKOFF_MS.length; i++) {
      const later = await tx((t) => deferRefund(t, r.id, { error: "The payment gateway could not be reached", at }));
      expect(later).toMatchObject({ status: "Pending", attempts: i + 1, lastError: "The payment gateway could not be reached" });
      expect(later.nextAttemptAt.getTime() - at.getTime()).toBe(REFUND_BACKOFF_MS[i]);
    }
    const failed = await tx((t) => deferRefund(t, r.id, { error: "Still unreachable", at }));
    expect(failed).toMatchObject({ status: "Failed", attempts: REFUND_MAX_ATTEMPTS, lastError: "Still unreachable" });
    expect(toWireRefund(failed).lastError).toBe("Still unreachable");
    const again = await tx((t) => moveRefund(t, r.id, "Pending"));
    expect(again).toMatchObject({ status: "Pending", attempts: 0, lastError: null });
  });
  it("fails at once on a refusal the gateway will repeat, and keeps the gateway's answer on a failed move", async () => {
    const qo = await order();
    const r = await tx((t) => queueRefund(t, { qrOrderId: qo, paymentId: "pay_1", amount: 20, reason: "void" }));
    expect(await tx((t) => deferRefund(t, r.id, { error: "The refund amount provided is greater than amount captured", final: true })))
      .toMatchObject({ status: "Failed", attempts: 1 });
    const s = await tx((t) => queueRefund(t, { qrOrderId: qo, paymentId: "pay_1", amount: 5, reason: "void" }));
    await tx((t) => moveRefund(t, s.id, "Sent", { rzpRefundId: "rfnd_2" }));
    expect(await tx((t) => moveRefund(t, s.id, "Failed", { error: "Refund failed at the bank" }))).toMatchObject({ status: "Failed", lastError: "Refund failed at the bank" });
    await expect(tx((t) => deferRefund(t, s.id, { error: "again", final: true }))).rejects.toThrow(`Refund ${s.id} is already failed`);
  });
});
