import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { PayerKindSchema } from "@rch/contract";
import AdminPayers from "../pages/AdminPayers";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import type { AdminPayer } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The payer register - the super admin's fifth tab. It covers what the table lists (every kind,
 * what each still owes), what the form sends, that a refusal leaves the form as typed, and the
 * one invariant the page exists to keep: a payer is switched off, never deleted, so a balance
 * always has an id somebody can find.
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

const payer = (over: Partial<AdminPayer>): AdminPayer =>
  ({ kind: "patient", id: "IP-2291", name: "Anand Kumar", active: true, outstanding: 0, bills: 0, ...over });

const PATIENT = payer({});
const STAFF = payer({ kind: "staff", id: "RC-4471", name: "Kavitha Raman", outstanding: 1240, bills: 3 });
const DEPT = payer({ kind: "dept", id: "CC-ICU", name: "Intensive Care" });
const DOCTOR = payer({ kind: "doctor", id: "DR-118", name: "Meera Iyer" });
/** Switched off and still owing: the row that proves neither half disappears. */
const CHASED = payer({ kind: "staff", id: "RC-9001", name: "Suresh Muthu", active: false, outstanding: 860, bills: 2 });

/** What every payer write announces (`PAYER_CHANGED`), so a case that writes must answer both
 *  read-backs or the write's own sentence comes back qualified. */
const CHANGED = ["payers", "roster"];
const EMPTY_ROSTER = { patients: [], staff: [], depts: [], doctors: [] };

const tick = () => act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });

async function mountPage() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminPayers))); });
  await tick();                                     // the register and the feed land
  const buttons = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));
  return {
    host,
    text: () => host.textContent ?? "",
    /** A renamed row carries its name in an input rather than in its text, so both are searched. */
    row: (needle: string) => [...host.querySelectorAll("tbody tr")].find((tr) =>
      tr.textContent?.includes(needle)
      || [...tr.querySelectorAll<HTMLInputElement>("input")].some((el) => el.value.includes(needle)))!,
    rows: () => [...host.querySelectorAll("tbody tr")].filter((tr) => !tr.querySelector(".empty")),
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

const typeInto = async (el: HTMLInputElement, v: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("the payer register", () => {
  it("lists every kind of payer, still-billing ones first", async () => {
    serve({
      "GET /api/v1/admin/payers": () => json([CHASED, DOCTOR, PATIENT, DEPT, STAFF]),
      "GET /api/v1/admin/actions": () => json([]),
    });
    page = await mountPage();
    // Every kind the closed union carries has a row, named by the word the domain uses for it.
    for (const p of [PATIENT, STAFF, DEPT, DOCTOR]) expect(page.row(p.id), `no row for ${p.id}`).toBeTruthy();
    expect(PayerKindSchema.options).toHaveLength(4);
    expect(page.row("IP-2291").textContent).toContain("patient");
    expect(page.row("CC-ICU").textContent).toContain("department");
    expect(page.row("DR-118").textContent).toContain("doctor");
    expect(page.row("RC-4471").textContent).toContain("staff member");
    // Still billing first, then by name; the one switched off is last whatever it is called.
    expect(page.rows().map((tr) => tr.querySelector(".mono")?.textContent))
      .toEqual(["IP-2291", "CC-ICU", "RC-4471", "DR-118", "RC-9001"]);
  });

  it("offers no delete, anywhere on the page - a payer is switched off instead", async () => {
    serve({
      "GET /api/v1/admin/payers": () => json([PATIENT, CHASED]),
      "GET /api/v1/admin/actions": () => json([]),
    });
    page = await mountPage();
    expect(page.buttons("Delete")).toHaveLength(0);
    expect(page.buttons("Remove")).toHaveLength(0);
    expect(page.text()).not.toContain("permanently");
    // What it offers instead, in both directions.
    expect(page.buttons("Switch off", page.row("IP-2291"))).toHaveLength(1);
    expect(page.buttons("Switch back on", page.row("RC-9001"))).toHaveLength(1);
  });

  it("still lists a switched-off payer, with the balance they are being chased for", async () => {
    serve({
      "GET /api/v1/admin/payers": () => json([CHASED]),
      "GET /api/v1/admin/actions": () => json([]),
    });
    page = await mountPage();
    const row = page.row("RC-9001");
    expect(row.textContent).toContain("Suresh Muthu");
    expect(row.textContent).toContain("Switched off");
    expect(row.textContent).toContain("₹860.00");
    expect(row.textContent).toContain("2");
  });

  it("sends the kind, the id and the name, and empties only the two boxes it filled", async () => {
    let list = [PATIENT];
    serve({
      "GET /api/v1/admin/payers": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/roster": () => json(EMPTY_ROSTER),
      "POST /api/v1/admin/payers": () => {
        list = [...list, DOCTOR];
        return json({ result: DOCTOR, changed: CHANGED, message: "Added Meera Iyer (DR-118) to the doctor register." });
      },
    });
    page = await mountPage();
    // The kinds on the form are the closed union's own, so "doctor" is an option without the
    // page listing one.
    const kind = page.field("Kind");
    expect([...kind.querySelectorAll("option")].map((o) => o.value)).toEqual([...PayerKindSchema.options]);
    await act(async () => { kind.value = "doctor"; kind.dispatchEvent(new Event("change", { bubbles: true })); });
    await typeInto(page.field("Id"), "DR-118");
    await typeInto(page.field("Name"), "Meera Iyer");
    await press(page.button("Add payer"));

    expect(bodyOf("POST /api/v1/admin/payers")).toEqual({ kind: "doctor", id: "DR-118", name: "Meera Iyer" });
    expect(S().toast).toBe("Added Meera Iyer (DR-118) to the doctor register.");
    expect(page.field("Id").value).toBe("");
    expect(page.field("Name").value).toBe("");
    // The kind stays where it was left: a ward list is entered a ward at a time.
    expect(page.field("Kind").value).toBe("doctor");
    expect(page.row("DR-118")).toBeTruthy();
  });

  it("will not send a create with an empty box, and leaves every word typed when the server refuses", async () => {
    serve({
      "GET /api/v1/admin/payers": () => json([PATIENT]),
      "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/payers": () =>
        json({ error: { code: "conflict", message: "IP-2291 is already on the register - Anand Kumar" } }, 409),
    });
    page = await mountPage();
    // Nothing typed: the button is shut rather than the request refused for us.
    expect(page.button("Add payer").disabled).toBe(true);
    await typeInto(page.field("Id"), "IP-2291");
    expect(page.button("Add payer").disabled).toBe(true);
    await typeInto(page.field("Name"), "Anand K");
    expect(page.button("Add payer").disabled).toBe(false);

    await press(page.button("Add payer"));
    expect(hit("POST /api/v1/admin/payers")).toHaveLength(1);
    expect(S().toast).toBe("IP-2291 is already on the register - Anand Kumar");
    expect(page.field("Id").value).toBe("IP-2291");
    expect(page.field("Name").value).toBe("Anand K");
  });

  it("switches a payer off with one press, sending the switch and nothing else", async () => {
    let list = [STAFF];
    const off = { ...STAFF, active: false };
    serve({
      "GET /api/v1/admin/payers": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/roster": () => json(EMPTY_ROSTER),
      "PATCH /api/v1/admin/payers/staff/RC-4471": () => {
        list = [off];
        return json({
          result: off, changed: CHANGED,
          message: "Kavitha Raman is switched off - no new bill may be posted to them, and the ₹1,240.00 they owe is still owed.",
        });
      },
    });
    page = await mountPage();
    await press(page.button("Switch off", page.row("RC-4471")));
    expect(bodyOf("PATCH /api/v1/admin/payers/staff/RC-4471")).toEqual({ active: false });
    // The server's own sentence, word for word - the page never writes its own.
    expect(S().toast).toContain("they owe is still owed");
    expect(page.buttons("Switch back on", page.row("RC-4471"))).toHaveLength(1);
  });

  it("switches one back on the same way, in the other direction", async () => {
    serve({
      "GET /api/v1/admin/payers": () => json([CHASED]),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/roster": () => json(EMPTY_ROSTER),
      "PATCH /api/v1/admin/payers/staff/RC-9001": () =>
        json({ result: { ...CHASED, active: true }, changed: CHANGED, message: "Suresh Muthu is back on the till's picker." }),
    });
    page = await mountPage();
    await press(page.button("Switch back on", page.row("RC-9001")));
    expect(bodyOf("PATCH /api/v1/admin/payers/staff/RC-9001")).toEqual({ active: true });
    expect(S().toast).toBe("Suresh Muthu is back on the till's picker.");
  });

  it("renames in place, and a refusal leaves the box open with what was typed", async () => {
    let refuse = true;
    serve({
      "GET /api/v1/admin/payers": () => json([PATIENT]),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/roster": () => json(EMPTY_ROSTER),
      "PATCH /api/v1/admin/payers/patient/IP-2291": () => refuse
        ? json({ error: { code: "rule", message: "Nothing to save - Anand Kumar already reads that way" } }, 422)
        : json({ result: { ...PATIENT, name: "Anand Kumar S" }, changed: CHANGED, message: "Saved Anand Kumar S." }),
    });
    page = await mountPage();
    await press(page.button("Rename", page.row("IP-2291")));
    const box = page.row("IP-2291").querySelector<HTMLInputElement>("input")!;
    expect(box.value).toBe("Anand Kumar");
    await typeInto(box, "Anand Kumar S");

    await press(page.button("Save", page.row("IP-2291")));
    expect(bodyOf("PATCH /api/v1/admin/payers/patient/IP-2291")).toEqual({ name: "Anand Kumar S" });
    expect(S().toast).toContain("already reads that way");
    expect(page.row("IP-2291").querySelector<HTMLInputElement>("input")!.value).toBe("Anand Kumar S");

    refuse = false;
    await press(page.button("Save", page.row("IP-2291")));
    expect(S().toast).toBe("Saved Anand Kumar S.");
    expect(page.row("IP-2291").querySelector("input")).toBeNull();
  });

  it("filters by kind and searches an id or a name", async () => {
    serve({
      "GET /api/v1/admin/payers": () => json([PATIENT, STAFF, DEPT, DOCTOR]),
      "GET /api/v1/admin/actions": () => json([]),
    });
    page = await mountPage();
    expect(page.rows()).toHaveLength(4);

    const kind = page.host.querySelector<HTMLSelectElement>('select[aria-label="Kind"]')!;
    await act(async () => { kind.value = "Staff"; kind.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(page.rows()).toHaveLength(1);
    expect(page.text()).toContain("of 4 on the register");

    await act(async () => { kind.value = "Everyone"; kind.dispatchEvent(new Event("change", { bubbles: true })); });
    const search = page.host.querySelector<HTMLInputElement>(".tbar .sfield input")!;
    await typeInto(search, "cc-icu");                 // the id, in the wrong case
    expect(page.rows()).toHaveLength(1);
    expect(page.text()).toContain("Intensive Care");
    await typeInto(search, "meera");                  // and by name
    expect(page.rows()).toHaveLength(1);
    expect(page.text()).toContain("DR-118");
    await typeInto(search, "nobody");
    expect(page.text()).toContain("No payer matches this search");
  });

  it("reads the register's own slice of the admin log as sentences", async () => {
    serve({
      "GET /api/v1/admin/payers": () => json([]),
      "GET /api/v1/admin/actions": () => json([
        { at: "2026-09-15T05:00:00.000Z", actor: "System Administrator", action: "payer_create", target: "Meera Iyer", details: { kind: "doctor" } },
        { at: "2026-09-15T04:00:00.000Z", actor: "System Administrator", action: "payer_deactivate", target: "Suresh Muthu", details: {} },
      ]),
    });
    page = await mountPage();
    expect(hit("GET /api/v1/admin/actions")[0][0]).toContain("kind=payers");
    expect(page.text()).toContain("System Administrator added Meera Iyer");
    expect(page.text()).toContain("System Administrator switched off Suresh Muthu");
    expect(page.text()).toContain("Nobody on the register yet");
  });
});
