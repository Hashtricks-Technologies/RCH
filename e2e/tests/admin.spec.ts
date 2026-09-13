import { expect, type Page, test } from "@playwright/test";
import { signIn, signInAdmin, toast } from "../fixtures/roles.js";

/**
 * A fresh, disposable account for a test to act on — never one of the six/seven seeded ones.
 * This suite runs alongside five others against one shared, un-reseeded stack (`e2e/README.md`
 * — no worker reseeds between files, and nothing here may race another spec's own seed data),
 * and unlike every other spec, these tests change an account's own password, role or location
 * rather than a document. Touching `ROLES.store`/`ROLES.counter` directly did exactly that to
 * the accounts `buying.spec.ts` and `request-chain.spec.ts` sign in as, and broke both — the
 * first time this file was written. A throwaway account this file creates and never gives back
 * to anyone is the fix.
 */
async function createDisposableAccount(page: Page): Promise<string> {
  const emp = `RC-${Math.floor(9000 + Math.random() * 900)}`;
  await page.getByLabel("Employee id").fill(emp);
  await page.getByLabel("Name").fill("Test Account");
  await page.getByLabel("Email").fill("test.account@royalcare.in");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(toast(page)).toContainText(`${emp}) created`);
  return emp;
}

/**
 * The dedicated admin account (`RC-0001`, seeded with the flag already on — root CLAUDE.md)
 * creates a real account through the browser, and that account signs in with the temporary
 * password shown once. A capability, not a role: this account never sees an operational
 * sidebar, only the standalone dashboard at `/admin`.
 */
test("an admin creates a staff account, and the new account signs in with the password shown once", async ({ page }) => {
  await signInAdmin(page);
  const emp = await createDisposableAccount(page);

  const passwordText = await page.locator(".al.g").innerText();
  const match = /password is ([^\s]+)/.exec(passwordText);
  if (!match) throw new Error(`no password in: ${JSON.stringify(passwordText)}`);
  const tempPassword = match[1];

  // The row is there.
  await expect(page.locator("table").getByText(emp, { exact: true })).toBeVisible();

  // Sign out (the dashboard's own header, not the Shell's — this account never sees the Shell
  // at all) and back in as the freshly created account with the password just shown.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Employee id").fill(emp);
  await page.getByLabel("Password", { exact: true }).fill(tempPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
});

test("an admin deactivates and reactivates an account", async ({ page }) => {
  await signInAdmin(page);
  const emp = await createDisposableAccount(page);

  const row = page.locator("tr", { has: page.getByText(emp, { exact: true }) });
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(toast(page)).toContainText("deactivated");
  await expect(row.getByText("Deactivated")).toBeVisible();

  await row.getByRole("button", { name: "Reactivate" }).click();
  await expect(toast(page)).toContainText("reactivated");
});

test("an admin resets a password, and moves the account to a different role and outlet", async ({ page }) => {
  await signInAdmin(page);
  // Created at "rest" (the default the create form opens on) with role counter.
  const emp = await createDisposableAccount(page);

  const row = page.locator("tr", { has: page.getByText(emp, { exact: true }) });
  await row.getByRole("button", { name: "Reset password" }).click();
  await expect(toast(page)).toContainText("Password reset");
  await expect(page.locator(".al.g")).toContainText(`${emp}'s temporary password is`);

  // Kitchen In-charge only ever works in the kitchen — the location picker narrows to it the
  // moment the role does, offering only the pairing the server would accept in the first place.
  await row.getByLabel(`Role for ${emp}`).selectOption("prod");
  await expect(row.getByLabel(`Location for ${emp}`).locator("option")).toHaveCount(1);
  await row.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toContainText("moved to Kitchen In-charge");
});

test("an ordinary account cannot reach /admin, and is told so by name", async ({ page }) => {
  await signIn(page, "manager");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Stock request approvals" })).toBeVisible();
  await expect(toast(page)).toContainText("is not available to an Outlet Manager");
});
