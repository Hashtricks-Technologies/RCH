import { expect, test, type Page } from "@playwright/test";
import { drawer, idFromToast, rowFor, signIn, toast } from "../fixtures/roles.js";

/**
 * The issue desk must print none of the six digits it is checking — Phase 6 withholds `otp`
 * from every caller but the collector, and the store's screens stop rendering it. That is a
 * server change and a UI change, and until both are in the tree the assertion below would fail
 * against a desk that still prints them. Turn it on with E2E_OTP_REDACTED=1 in the same commit
 * that lands the redaction, and delete this switch in the one after.
 */
const OTP_REDACTED = process.env.E2E_OTP_REDACTED === "1";

test("a request walks from the counter to the shelf, live in both windows", async ({ browser }) => {
  // Three sign-ins, two live windows and six round trips: this is the longest scenario in the
  // suite and the only one that waits on another browser rather than on its own click.
  test.setTimeout(120_000);

  const counterCtx = await browser.newContext();
  const managerCtx = await browser.newContext();
  const storeCtx = await browser.newContext();
  const counter: Page = await counterCtx.newPage();
  const manager: Page = await managerCtx.newPage();
  const store: Page = await storeCtx.newPage();
  await signIn(counter, "counter");
  await signIn(manager, "manager");
  await signIn(store, "store");

  // 1. The counter asks.
  await counter.getByRole("navigation").getByRole("link", { name: "Stock Requests" }).click();
  await counter.getByRole("button", { name: "From inventory" }).click();
  await counter.locator(".raisecard-product select").selectOption("milk");
  await counter.locator(".raisecard").getByLabel("Quantity").fill("6");
  await counter.locator(".raisecard").getByLabel("Notes").fill("Milk finished at 09:10");
  await counter.getByRole("button", { name: "Submit request" }).click();
  await expect(toast(counter)).toContainText("with the outlet manager now");
  const req = await idFromToast(counter, /REQ-\d{4}-0\d+/);

  // 2. It is on the manager's queue without anybody reloading. This is the SSE assertion: the
  //    manager's window has not navigated since sign-in.
  await manager.getByRole("navigation").getByRole("link", { name: "Approvals" }).click();
  await expect(manager.getByText(req)).toBeVisible({ timeout: 15_000 });

  // 3. The manager approves it, and the counter's own list moves without a reload.
  await rowFor(manager, req).click();
  await drawer(manager).getByRole("button", { name: "Approve & forward" }).click();
  await expect(toast(manager)).toContainText(`${req} manager approved and forwarded to the store keeper`);
  await expect(rowFor(counter, req)).toContainText("Manager approved", { timeout: 15_000 });

  // 4. The store issues it and reads the OTP off the collector's screen, not off its own — the
  //    issue desk no longer prints it, which is the whole point of Phase 6's redaction.
  await store.getByRole("navigation").getByRole("link", { name: "Issue Desk" }).click();
  await expect(store.getByText(req)).toBeVisible({ timeout: 15_000 });
  await rowFor(store, req).click();
  await drawer(store).getByRole("button", { name: "Generate ticket" }).click();
  const tkt = await idFromToast(store, /TKT-0\d+/);
  await expect(toast(store)).toContainText(`${tkt} issued — Coffee Shop can collect against this ticket`);
  if (OTP_REDACTED) {
    // The digits are not on the sending side's screen at all. `.otp-v` is the six-digit face
    // (UI/src/styles.css, alongside `.otp`, `.otp-l` and `.otp-in`); the issue desk must render
    // none of them. Asserting on a class that does not exist would pass either way, which is
    // the one thing this assertion — the smoke's whole proof of the redaction — must not do.
    await expect(store.locator(".otp-v")).toHaveCount(0);
  } else {
    // Say so in the report rather than passing quietly over the one thing that is not checked.
    test.info().annotations.push({
      type: "not asserted",
      description: "the issue desk's OTP redaction — set E2E_OTP_REDACTED=1 once it is in the tree",
    });
  }

  // The collector's own screen is where the six digits live, and the ticket drawer is where a
  // counter operator reads them out.
  await counter.getByRole("navigation").getByRole("link", { name: "Pick Tickets" }).click();
  await rowFor(counter, tkt).click();
  const otp = (await drawer(counter).locator(".otp-v").innerText()).replace(/\D/g, "");
  expect(otp).toMatch(/^\d{6}$/);
  await counter.keyboard.press("Escape");
  await expect(drawer(counter)).toBeHidden();

  await store.getByLabel("OTP quoted by the collector").fill(otp);
  await store.getByRole("button", { name: "Hand over on OTP" }).click();
  await expect(toast(store)).toContainText(`${tkt} handed over — stock is in transit to Coffee Shop`);

  // 5. The counter receives it, and the shelf it lands on is theirs.
  await expect(rowFor(counter, tkt)).toContainText("Collected", { timeout: 15_000 });
  await rowFor(counter, tkt).getByRole("button", { name: "Receive" }).click();
  await expect(toast(counter)).toContainText("Received at Coffee Shop — stock is on the shelf");
  await expect(rowFor(counter, tkt)).toContainText("Received");

  await counterCtx.close();
  await managerCtx.close();
  await storeCtx.close();
});
