import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import AdminUsers from "../pages/AdminUsers";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import type { AdminUser } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The account page's three newer rules, as the super admin meets them: the employee number is
 * the server's to give (the form previews the next one), the super admin's own row has no role or
 * location to change, and a deactivated staff account can be deleted behind a second press.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const account = (over: Partial<AdminUser>): AdminUser => ({
  id: "u1", emp: "RC-4471", n: "Kavitha Raman", e: "kavitha.r@royalcare.in", ph: "", r: "counter",
  rl: "Counter Operator", loc: "coffee", col: "#B45309", active: true, mustChangePassword: false, admin: false, ...over,
});
const SUPER = account({ id: "u7", emp: "RC-0001", n: "System Administrator", r: "buyer", rl: "Super Admin", loc: "store", admin: true });
const KAVITHA = account({});
const DEEPA = account({ id: "u6", emp: "RC-4482", n: "Deepa Selvam", loc: "kiosk", active: false });

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make ? make() : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const hit = (at: string) =>
  fetchMock.mock.calls.filter(([u, init]) => `${(init as RequestInit).method} ${String(u).split("?")[0]}` === at);

const tick = () => act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });

async function mountPage() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminUsers))); });
  await tick();                                     // the list and the feed land
  const buttons = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));
  return {
    text: () => host.textContent ?? "",
    /** The table row that names this employee number. */
    row: (emp: string) => [...host.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(emp))!,
    field: (label: string) => {
      const l = [...host.querySelectorAll("label")].find((x) => (x.textContent ?? "").trim() === label)!;
      return host.querySelector<HTMLInputElement>(`#${CSS.escape(l.htmlFor)}`)!;
    },
    button: (label: string, scope: ParentNode = host) => buttons(scope, label)[0],
    buttons: (label: string, scope: ParentNode = host) => buttons(scope, label),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Page = Awaited<ReturnType<typeof mountPage>>;

const press = async (b: HTMLButtonElement | undefined) => {
  expect(b, "no such button").toBeTruthy();
  await act(async () => { b!.click(); await new Promise((r) => { setTimeout(r, 0); }); });
};

let page: Page | undefined;
beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  act(() => {
    as("manager");
    setAccessToken("admin-tok");
    useApp.setState({ user: { ...S().user!, admin: true } });
  });
});
afterEach(() => { page?.unmount(); page = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

describe("the account page", () => {
  it("previews the next employee number, read-only, and creates without sending one", async () => {
    let list = [SUPER, KAVITHA, DEEPA];
    serve({
      "GET /api/v1/admin/users": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/users": () => {
        const made = account({ id: "u8", emp: "RC-4483", n: "Anitha R", e: "anitha.r@royalcare.in", loc: "rest", mustChangePassword: true });
        list = [...list, made];
        return json({ result: { ...made, tempPassword: "one-time-pass-1" }, changed: ["accounts"], message: "Anitha R (RC-4483) created - the temporary password shown above is not stored anywhere and will not be shown again" });
      },
    });
    page = await mountPage();
    const emp = page.field("Employee id");
    expect(emp.readOnly).toBe(true);
    expect(emp.value).toBe("RC-4483");
    expect(page.text()).toContain("Assigned when you save");

    await act(async () => {
      for (const [label, v] of [["Name", "Anitha R"], ["Email", "anitha.r@royalcare.in"]] as const) {
        const el = page!.field(label);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await press(page.button("Create account"));
    const [, init] = hit("POST /api/v1/admin/users")[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "Anitha R", email: "anitha.r@royalcare.in", role: "counter", loc: "rest" });
    expect(page.text()).toContain("RC-4483's temporary password is one-time-pass-1");
    // The list came back with the new account in it, so the preview has moved on.
    expect(page.field("Employee id").value).toBe("RC-4484");
  });

  it("refuses to send a create with no name or email, and says what is missing", async () => {
    serve({ "GET /api/v1/admin/users": () => json([SUPER]), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    expect(page.field("Employee id").value).toBe("RC-0002");
    await press(page.button("Create account"));
    expect(hit("POST /api/v1/admin/users")).toHaveLength(0);
    expect(S().toast).toBe("Give the account a name and an email before saving");
  });

  it("shows the super admin as Super Admin, with no role or location to change", async () => {
    serve({ "GET /api/v1/admin/users": () => json([SUPER, KAVITHA]), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    const superRow = page.row("RC-0001");
    expect(superRow.textContent).toContain("Super Admin");
    expect(superRow.textContent).not.toContain("Procurement Officer");
    expect(superRow.querySelector("select")).toBeNull();
    expect(page.buttons("Save", superRow)).toHaveLength(0);
    // An ordinary account keeps its pickers.
    const staffRow = page.row("RC-4471");
    expect(staffRow.querySelector(`select[aria-label="Role for RC-4471"]`)).toBeTruthy();
    expect(page.buttons("Save", staffRow)).toHaveLength(1);
  });

  it("offers Delete only on a deactivated staff account", async () => {
    const closedSuper = { ...SUPER, id: "u9", emp: "RC-0002", active: false };
    serve({ "GET /api/v1/admin/users": () => json([SUPER, closedSuper, KAVITHA, DEEPA]), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    expect(page.buttons("Delete", page.row("RC-4482"))).toHaveLength(1);
    expect(page.buttons("Delete", page.row("RC-4471"))).toHaveLength(0);     // still active
    expect(page.buttons("Delete", page.row("RC-0002"))).toHaveLength(0);     // admin-flagged
    expect(page.buttons("Delete", page.row("RC-0001"))).toHaveLength(0);
  });

  it("asks a second time, and Keep sends nothing", async () => {
    serve({ "GET /api/v1/admin/users": () => json([SUPER, DEEPA]), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    await press(page.button("Delete", page.row("RC-4482")));
    const row = page.row("RC-4482");
    expect(page.button("Delete RC-4482 permanently", row)).toBeTruthy();
    // The row's other doors are put away while the question stands.
    expect(page.buttons("Reset password", row)).toHaveLength(0);
    expect(page.buttons("Reactivate", row)).toHaveLength(0);

    await press(page.button("Keep", row));
    expect(hit("DELETE /api/v1/admin/users/u6")).toHaveLength(0);
    expect(page.buttons("Delete RC-4482 permanently", page.row("RC-4482"))).toHaveLength(0);
    expect(page.buttons("Reactivate", page.row("RC-4482"))).toHaveLength(1);
  });

  it("deletes on the second press, and the row is gone once the list comes back", async () => {
    let list = [SUPER, DEEPA];
    serve({
      "GET /api/v1/admin/users": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "DELETE /api/v1/admin/users/u6": () => {
        list = [SUPER];
        return json({ result: { id: "u6", emp: "RC-4482", n: "Deepa Selvam" }, changed: ["accounts"], message: "Deepa Selvam (RC-4482) deleted permanently" });
      },
    });
    page = await mountPage();
    await press(page.button("Delete", page.row("RC-4482")));
    await press(page.button("Delete RC-4482 permanently", page.row("RC-4482")));
    expect(hit("DELETE /api/v1/admin/users/u6")).toHaveLength(1);
    expect(S().toast).toBe("Deepa Selvam (RC-4482) deleted permanently");
    expect(page.row("RC-4482")).toBeUndefined();
  });

  it("keeps the question up, with the server's sentence, when the delete is refused", async () => {
    serve({
      "GET /api/v1/admin/users": () => json([SUPER, DEEPA]),
      "GET /api/v1/admin/actions": () => json([]),
      "DELETE /api/v1/admin/users/u6": () => json({ error: { code: "conflict", message: "Refused - Deepa Selvam (RC-4482) has records in the ledger; an account with history can only be deactivated" } }, 409),
    });
    page = await mountPage();
    await press(page.button("Delete", page.row("RC-4482")));
    await press(page.button("Delete RC-4482 permanently", page.row("RC-4482")));
    expect(S().toast).toContain("can only be deactivated");
    expect(page.row("RC-4482")).toBeTruthy();
    expect(page.buttons("Keep", page.row("RC-4482"))).toHaveLength(1);
  });

  it("reads a delete in the recent-actions feed as a sentence", async () => {
    serve({
      "GET /api/v1/admin/users": () => json([SUPER]),
      "GET /api/v1/admin/actions": () => json([
        { at: "2026-09-14T05:00:00.000Z", actor: "System Administrator", action: "delete", target: "Deepa Selvam", details: { emp: "RC-4482" } },
        { at: "2026-09-14T04:00:00.000Z", actor: "System Administrator", action: "reset_password", target: "Kavitha Raman", details: {} },
      ]),
    });
    page = await mountPage();
    expect(page.text()).toContain("System Administrator deleted Deepa Selvam");
    expect(page.text()).toContain("System Administrator reset the password of Kavitha Raman");
  });
});
