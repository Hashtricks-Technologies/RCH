import { expect, test } from "@playwright/test";
import { drawer, rowFor, signIn, toast } from "../fixtures/roles.js";

test("a ticket is raised, answered, resolved and rated — and stays the raiser's own", async ({ page, browser }) => {
  await signIn(page, "counter");
  await page.getByRole("navigation").getByRole("link", { name: "Support" }).click();
  // The subject carries the clock, so a second run against the same database cannot match the
  // first run's ticket and call it a pass.
  const subject = `Smoke ${Date.now()}`;
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("What happened").fill("Raised by the end-to-end smoke.");
  await page.getByRole("button", { name: "Send to support" }).click();
  await expect(toast(page)).toContainText(/^SUP-00\d+ raised — support replies to urgent tickets within the hour$/);

  await rowFor(page, subject).click();
  await drawer(page).getByLabel("Your message").fill("Still happening.");
  await drawer(page).getByRole("button", { name: "Send reply" }).click();
  await expect(toast(page)).toContainText(/^Reply sent on SUP-00\d+$/);

  await drawer(page).getByRole("button", { name: "Mark resolved" }).click();
  await expect(toast(page)).toContainText(/^SUP-00\d+ — resolved$/);
  await drawer(page).getByRole("button", { name: "5", exact: true }).click();
  await expect(toast(page)).toContainText(/^Thank you — 5 out of 5 recorded against SUP-00\d+$/);
  await expect(drawer(page)).toContainText("You rated this 5 out of 5.");

  // And it is nobody else's business.
  const buyer = await (await browser.newContext()).newPage();
  await signIn(buyer, "buyer");
  await buyer.getByRole("navigation").getByRole("link", { name: "Support" }).click();
  await expect(buyer.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
  await expect(buyer.getByText(subject)).toHaveCount(0);
});
