import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { DESK_DEFAULTS } from "@rch/domain";
import AdminRoles from "../pages/AdminRoles";
import Drawer from "../ui/Drawer";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import type { AdminRole, Permissions, Role } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The Roles tab: the list, the create form, and the permission matrix in its drawer - what each
 * control sends, what the matrix will not offer a desk, and that the server's refusals are
 * printed in its own words.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
const bodyOf = (at: string, n = 0) => JSON.parse(String((hit(at)[n][1] as RequestInit).body)) as Record<string, unknown>;

const DESKS: Role[] = ["counter", "manager", "store", "prod", "buyer"];
const role = (over: Partial<AdminRole> & { desk: Role }): AdminRole => ({
  id: "ROLE-001", name: DESK_DEFAULTS[over.desk].name, active: true, perms: DESK_DEFAULTS[over.desk].perms,
  holders: 1, everAssigned: true, updatedAt: "2026-09-24T03:00:00.000Z", ...over,
});
/** The five seeded roles, then one a super admin made and never gave to anybody. */
const SEEDED = DESKS.map((desk, i) => role({ id: `ROLE-00${i + 1}`, desk, holders: i === 0 ? 2 : 1 }));
const NIGHT = role({ id: "ROLE-006", name: "Night Cashier", desk: "counter", holders: 0, everAssigned: false });
const ROLES = [...SEEDED, NIGHT];

const tick = () => act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });

async function mountPage() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // The dashboard hosts the drawer beside the tab; so does this.
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(Fragment, null, createElement(AdminRoles), createElement(Drawer))));
  });
  await tick();
  const buttons = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label);
  const drawer = () => host.querySelector<HTMLElement>(".drb")!;
  return {
    host,
    text: () => host.textContent ?? "",
    row: (needle: string) => [...host.querySelectorAll("tbody tr")].find((tr) => tr.textContent?.includes(needle))!,
    field: (label: string, scope: ParentNode = host) => {
      const l = [...scope.querySelectorAll("label")].find((x) => (x.textContent ?? "").trim() === label)!;
      return host.querySelector<HTMLInputElement & HTMLSelectElement>(`#${CSS.escape(l.htmlFor)}`)!;
    },
    button: (label: string, scope: ParentNode = host) => buttons(scope, label)[0],
    drawer,
    /** The None / View / Edit buttons of one feature in the open matrix. */
    levels: (feature: string) => {
      const g = drawer().querySelector(`[aria-label="${feature} access"]`)!;
      return Object.fromEntries([...g.querySelectorAll("button")].map((b) => [b.textContent, b])) as Record<string, HTMLButtonElement>;
    },
    box: (label: string) => drawer().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Page = Awaited<ReturnType<typeof mountPage>>;

const press = async (b: HTMLElement | undefined) => {
  expect(b, "no such button").toBeTruthy();
  await act(async () => { b!.click(); await new Promise((r) => { setTimeout(r, 0); }); });
};
const setValue = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
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

describe("the Roles tab", () => {
  it("lists every role with its desk and holders, and the roles feed", async () => {
    serve({
      "GET /api/v1/admin/roles": () => json(ROLES),
      "GET /api/v1/admin/actions": () => json([{ at: "2026-09-24T04:00:00.000Z", actor: "System Administrator", action: "role_create", target: "Night Cashier", details: {} }]),
    });
    page = await mountPage();
    expect(hit("GET /api/v1/admin/actions")[0][0]).toContain("kind=roles");
    expect(page.row("ROLE-001").textContent).toContain("Counter Operator");
    expect(page.row("ROLE-001").textContent).toContain("Counter");
    expect(page.row("ROLE-003").textContent).toContain("Store");
    expect(page.text()).toContain("System Administrator created Night Cashier");
  });

  it("creates a role from its desk's seeded grants and opens the matrix on it", async () => {
    const made = role({ id: "ROLE-007", name: "Relief Manager", desk: "manager", holders: 0, everAssigned: false });
    let list = ROLES;
    serve({
      "GET /api/v1/admin/roles": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/roles": () => {
        list = [...list, made];
        return json({ result: made, changed: ["roles"], message: "Relief Manager (ROLE-007) created on the outlet manager desk." });
      },
    });
    page = await mountPage();
    await setValue(page.field("Name"), "Relief Manager");
    await setValue(page.field("Desk"), "manager");
    await press(page.button("Create role"));
    expect(bodyOf("POST /api/v1/admin/roles")).toEqual({ name: "Relief Manager", desk: "manager", perms: DESK_DEFAULTS.manager.perms });
    expect(S().toast).toBe("Relief Manager (ROLE-007) created on the outlet manager desk.");
    expect(S().drawer).toEqual({ t: "role", id: "ROLE-007" });
    expect(page.drawer().textContent).toContain("Prices");
    // Cleared for the next one.
    expect(page.field("Name").value).toBe("");
  });

  it("keeps the form as typed when the server refuses the name", async () => {
    serve({
      "GET /api/v1/admin/roles": () => json(ROLES),
      "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/roles": () => json({ error: { code: "conflict", message: "A role called Night Cashier already exists." } }, 409),
    });
    page = await mountPage();
    await setValue(page.field("Name"), "Night Cashier");
    await press(page.button("Create role"));
    expect(S().toast).toBe("A role called Night Cashier already exists.");
    expect(page.field("Name").value).toBe("Night Cashier");
    expect(S().drawer).toBeNull();
  });

  it("edits the matrix, lists what changes, and sends only the permissions", async () => {
    const saved: AdminRole = { ...NIGHT, perms: { f: { ...NIGHT.perms.f, z_report: "edit" }, a: [] }, updatedAt: "2026-09-24T05:00:00.000Z" };
    let list = ROLES;
    serve({
      "GET /api/v1/admin/roles": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "PATCH /api/v1/admin/roles/ROLE-006": () => {
        list = [...SEEDED, saved];
        return json({ result: saved, changed: ["roles"], message: "Night Cashier saved - it reaches its holders on their next click." });
      },
    });
    page = await mountPage();
    await press(page.button("Edit", page.row("ROLE-006")));
    expect(page.button("Save", page.host.querySelector(".drf")!).disabled).toBe(true);
    expect(page.drawer().textContent).toContain("Nothing yet");
    // Z reports offers all three; the counter desk may hold every one.
    const z = page.levels("Z reports");
    expect(Object.keys(z)).toEqual(["None", "View", "Edit"]);
    expect(z.None.getAttribute("aria-pressed")).toBe("true");
    await press(z.Edit);
    expect(page.levels("Z reports").Edit.getAttribute("aria-pressed")).toBe("true");
    expect(page.drawer().textContent).toContain("Z reports: None → Edit");
    await press(page.button("Save", page.host.querySelector(".drf")!));
    const body = bodyOf("PATCH /api/v1/admin/roles/ROLE-006");
    expect(Object.keys(body)).toEqual(["perms"]);
    expect((body.perms as Permissions).f.z_report).toBe("edit");
    expect((body.perms as Permissions).f.billing).toBe("edit");
    expect(S().toast).toBe("Night Cashier saved - it reaches its holders on their next click.");
    // The drawer starts again from what the server stored: nothing left to save.
    expect(page.drawer().textContent).toContain("Nothing yet");
  });

  it("renames, and sends the name alone", async () => {
    serve({
      "GET /api/v1/admin/roles": () => json(ROLES),
      "GET /api/v1/admin/actions": () => json([]),
      "PATCH /api/v1/admin/roles/ROLE-006": () => json({ error: { code: "conflict", message: "A role called Counter Operator already exists." } }, 409),
    });
    page = await mountPage();
    await press(page.button("Edit", page.row("ROLE-006")));
    await setValue(page.field("Name", page.drawer()), "Counter Operator");
    expect(page.drawer().textContent).toContain("Name: Night Cashier → Counter Operator");
    await press(page.button("Save", page.host.querySelector(".drf")!));
    expect(bodyOf("PATCH /api/v1/admin/roles/ROLE-006")).toEqual({ name: "Counter Operator" });
    // Refused: the server's sentence, and the drawer exactly as it was.
    expect(S().toast).toBe("A role called Counter Operator already exists.");
    expect(page.field("Name", page.drawer()).value).toBe("Counter Operator");
  });

  it("shuts a level the desk may not be given, with the sentence the server would refuse it with", async () => {
    serve({ "GET /api/v1/admin/roles": () => json(ROLES), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    await press(page.button("Edit", page.row("ROLE-006")));
    const issue = page.levels("Issue desk");
    expect(issue.None.disabled).toBe(false);
    expect(issue.View.disabled).toBe(true);
    expect(issue.Edit.disabled).toBe(true);
    expect(page.drawer().textContent).toContain("The counter desk can't be given view access to Issue desk.");
    // An edit-only feature offers no View at all.
    expect(Object.keys(page.levels("Product on / off"))).toEqual(["None", "Edit"]);
    // A view-only one offers no Edit.
    expect(Object.keys(page.levels("X reports"))).toEqual(["None", "View"]);
  });

  it("holds an action shut until its parent feature is held, and drops it with the parent", async () => {
    serve({ "GET /api/v1/admin/roles": () => json(ROLES), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    await press(page.button("Edit", page.row("ROLE-006")));
    // Bills is held at edit, so Void a bill may be given; Credit is not, so Void a settlement may not.
    expect(page.box("Void a bill").disabled).toBe(false);
    expect(page.box("Void a settlement").disabled).toBe(true);
    expect(page.drawer().textContent).toContain("\"Void a settlement\" needs at least view access to Credit & settlements.");
    await press(page.box("Void a bill"));
    expect(page.box("Void a bill").checked).toBe(true);
    await press(page.levels("Bills").None);
    expect(page.box("Void a bill").checked).toBe(false);
    expect(page.box("Void a bill").disabled).toBe(true);
    await press(page.levels("Credit & settlements").View);
    expect(page.box("Void a settlement").disabled).toBe(false);
  });

  it("offers Works for every outlet on the counter and manager desks only", async () => {
    serve({ "GET /api/v1/admin/roles": () => json(ROLES), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    const sw = () => page!.drawer().querySelector('button[aria-label="Works for every outlet"]');
    await press(page.button("Edit", page.row("ROLE-006")));
    expect(sw()).toBeTruthy();
    await press(page.button("Edit", page.row("ROLE-002")));
    expect(sw()?.getAttribute("aria-pressed")).toBe("true");
    for (const id of ["ROLE-003", "ROLE-004", "ROLE-005"]) {
      await press(page.button("Edit", page.row(id)));
      expect(sw(), id).toBeNull();
    }
  });

  it("warns how many accounts a change reaches, and fixes the desk once the role was given", async () => {
    serve({ "GET /api/v1/admin/roles": () => json(ROLES), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    await press(page.button("Edit", page.row("ROLE-001")));
    expect(page.drawer().textContent).toContain("2 accounts hold this role - changes apply at once.");
    expect(page.field("Desk", page.drawer()).disabled).toBe(true);
    await press(page.button("Edit", page.row("ROLE-006")));
    expect(page.drawer().textContent).not.toContain("changes apply at once");
    // Never given: its desk may move, and a grant the new desk may not hold goes with it.
    const desk = page.field("Desk", page.drawer());
    expect(desk.disabled).toBe(false);
    await setValue(desk, "store");
    expect(page.drawer().textContent).toContain("Desk: Counter → Store");
    expect(page.drawer().textContent).toContain("Bills: Edit → None");
    expect(page.drawer().querySelector('button[aria-label="Works for every outlet"]')).toBeNull();
  });

  it("prints the server's refusal to switch off a role somebody still holds", async () => {
    const sentence = "Counter Operator is still held by Kavitha Raman (RC-4471) and Deepa Selvam (RC-4482) - give them another role first.";
    serve({
      "GET /api/v1/admin/roles": () => json(ROLES),
      "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/roles/ROLE-001/deactivate": () => json({ error: { code: "conflict", message: sentence } }, 409),
    });
    page = await mountPage();
    await press(page.button("Deactivate", page.row("ROLE-001")));
    expect(hit("POST /api/v1/admin/roles/ROLE-001/deactivate")).toHaveLength(1);
    expect(S().toast).toBe(sentence);
  });

  it("switches a role off and back on", async () => {
    let list = ROLES;
    serve({
      "GET /api/v1/admin/roles": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/roles/ROLE-006/deactivate": () => {
        list = [...SEEDED, { ...NIGHT, active: false }];
        return json({ result: { ...NIGHT, active: false }, changed: ["roles"], message: "Night Cashier is switched off." });
      },
      "POST /api/v1/admin/roles/ROLE-006/reactivate": () => {
        list = ROLES;
        return json({ result: NIGHT, changed: ["roles"], message: "Night Cashier is back on." });
      },
    });
    page = await mountPage();
    await press(page.button("Deactivate", page.row("ROLE-006")));
    expect(S().toast).toBe("Night Cashier is switched off.");
    expect(page.row("ROLE-006").textContent).toContain("Switched off");
    await press(page.button("Reactivate", page.row("ROLE-006")));
    expect(S().toast).toBe("Night Cashier is back on.");
    expect(page.row("ROLE-006").textContent).toContain("Active");
  });

  it("offers Delete only on a role nobody was ever given, behind a second press", async () => {
    let list = ROLES;
    serve({
      "GET /api/v1/admin/roles": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "DELETE /api/v1/admin/roles/ROLE-006": () => {
        list = SEEDED;
        return json({ result: NIGHT, changed: ["roles"], message: "Night Cashier deleted." });
      },
    });
    page = await mountPage();
    for (const r of SEEDED) expect(page.button("Delete", page.row(r.id)), r.id).toBeUndefined();
    await press(page.button("Delete", page.row("ROLE-006")));
    // One press is a question.
    expect(hit("DELETE /api/v1/admin/roles/ROLE-006")).toHaveLength(0);
    await press(page.button("Keep", page.row("ROLE-006")));
    expect(page.button("Edit", page.row("ROLE-006"))).toBeTruthy();
    await press(page.button("Delete", page.row("ROLE-006")));
    await press(page.button("Delete Night Cashier permanently", page.row("ROLE-006")));
    expect(hit("DELETE /api/v1/admin/roles/ROLE-006")).toHaveLength(1);
    expect(S().toast).toBe("Night Cashier deleted.");
    expect(page.text()).not.toContain("ROLE-006");
  });

  it("says a role that is not on the list is not there", async () => {
    serve({ "GET /api/v1/admin/roles": () => json(ROLES), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    act(() => { S().openDrawer("role", "ROLE-099"); });
    expect(page.drawer().textContent).toContain("This role is not on the list");
  });
});
