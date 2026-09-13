import { expect, test } from "@playwright/test";
import { ROLES, signIn, toast } from "../fixtures/roles.js";

/**
 * The one account flagged for it (`pnpm --filter @rch/api users set-admin --emp RC-3120 --on`,
 * run against the seed before this spec — the CLI is the only door onto the flag, so the smoke
 * cannot grant it itself) creates a real account through the browser, and that account signs in
 * with the password just shown.
 */
test("an admin creates a staff account, and the new account signs in with the password shown once", async ({ page }) => {
  await signIn(page, "manager");

  await page.goto("/#/settings");
  await page.getByRole("button", { name: "Manage staff accounts" }).click();
  await expect(page.getByRole("heading", { name: "Manage staff accounts" })).toBeVisible();

  const emp = `RC-${Math.floor(9000 + Math.random() * 900)}`;
  await page.getByLabel("Employee id").fill(emp);
  await page.getByLabel("Name").fill("Anitha R");
  await page.getByLabel("Email").fill("anitha.r@royalcare.in");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(toast(page)).toContainText(`${emp}) created`);
  const passwordText = await page.locator(".al.g").innerText();
  const match = /password is ([^\s]+)/.exec(passwordText);
  if (!match) throw new Error(`no password in: ${JSON.stringify(passwordText)}`);
  const tempPassword = match[1];

  // The row is there.
  await expect(page.locator("table").getByText(emp, { exact: true })).toBeVisible();

  // Sign out (the sidebar footer's own name button is the sign-out control, Shell.tsx's `.su`)
  // and back in as the freshly created account with the password just shown. Waiting on the
  // "Sign in" heading rather than the "Employee id" label: the admin page's own create-account
  // form has a field with that same label, still mounted for a moment after the click, and
  // `.fill` landing on it instead of the login page's is exactly what happened the first time
  // this test was written.
  await page.locator(".su").click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Employee id").fill(emp);
  await page.getByLabel("Password", { exact: true }).fill(tempPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
});

test("an admin deactivates and reactivates a colleague's account", async ({ page }) => {
  await signIn(page, "manager");
  await page.goto("/#/admin");
  await expect(page.getByRole("heading", { name: "Manage staff accounts" })).toBeVisible();

  const row = page.locator("tr", { has: page.getByText(ROLES.counter.emp, { exact: false }) });
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(toast(page)).toContainText("deactivated");
  await expect(row.getByText("Deactivated")).toBeVisible();

  await row.getByRole("button", { name: "Reactivate" }).click();
  await expect(toast(page)).toContainText("reactivated");
});

test("an admin resets a colleague's password, and moves them to a different outlet", async ({ page }) => {
  await signIn(page, "manager");
  await page.goto("/#/admin");

  const row = page.locator("tr", { has: page.getByText(ROLES.store.emp, { exact: false }) });
  await row.getByRole("button", { name: "Reset password" }).click();
  await expect(toast(page)).toContainText("Password reset");
  await expect(page.locator(".al.g")).toContainText(`${ROLES.store.emp}'s temporary password is`);

  // Store Keeper only ever works at the central store — moving it to the kiosk is refused,
  // and the two pickers offer only the pairing the server would accept in the first place.
  await row.getByLabel(`Role for ${ROLES.store.emp}`).selectOption("counter");
  await expect(row.getByLabel(`Location for ${ROLES.store.emp}`).locator("option")).toHaveCount(3);
  await row.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toContainText("moved to Counter Operator");
});
