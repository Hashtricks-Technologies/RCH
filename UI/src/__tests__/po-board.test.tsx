import { beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import * as FX from "@rch/contract/fixtures";
import { applyPos } from "../api/wire";
import PurchaseOrders, { newestFirst } from "../roles/buyer/PurchaseOrders";
import Drawer from "../ui/Drawer";
import "../roles/buyer/PoDrawer";               // registers "bpo" on the drawer registry
import type { PoStatus, PurchaseOrder } from "../types";
import { useApp } from "../store";
import { as, clone, resetStore, S } from "./fixture";

/**
 * The buyer's purchase orders as a board: a column per stage, side by side, a card per order, and
 * the order's details in the drawer that slides in from the right. Partially and fully received
 * orders share the Received column, which filters to either. The newest order raised sits on top
 * of its column, whatever order the server handed the list over in.
 */

beforeEach(resetStore);

const COLUMNS: PoStatus[] = ["Draft", "Ordered", "Received", "Cancelled"];
/** The column an order of this status is drawn in. */
const columnOf = (st: PoStatus): PoStatus => (st === "Partially received" ? "Received" : st);

function mount(node: Parameters<typeof createElement>[0]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(node))); });
  const column = (st: PoStatus) =>
    [...host.querySelectorAll<HTMLElement>("section.kan-col")].find((c) => c.getAttribute("aria-label")?.startsWith(`${st} — `));
  return {
    host,
    column,
    /** The order ids on a column's cards, top to bottom. */
    ids: (st: PoStatus) =>
      [...column(st)!.querySelectorAll("button[aria-label^='Open ']")].map((b) => b.getAttribute("aria-label")!.slice("Open ".length)),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}

/** A copy of a seeded order under a new id, status and raise instant. */
const orderAs = (base: PurchaseOrder, id: string, st: PoStatus, iso: string) =>
  ({ ...clone(base), id, st, iso, at: iso.slice(11, 16), hist: [] });

describe("the purchase orders board", () => {
  it("draws a column per stage, in the order an order travels", () => {
    as("buyer");
    const ui = mount(PurchaseOrders);
    const labels = [...ui.host.querySelectorAll("section.kan-col")].map((c) => c.getAttribute("aria-label")!.split(" — ")[0]);
    expect(labels).toEqual(COLUMNS);
    // One board, the columns side by side in the one `.kan.fill` row.
    expect(ui.host.querySelectorAll(".kan.fill > section.kan-col")).toHaveLength(COLUMNS.length);
    ui.unmount();
  });

  it("puts a card for every order in the column for its status, closed ones included", () => {
    as("buyer");
    const base = S().po[0];
    act(() => {
      useApp.setState({
        po: [
          ...S().po,
          orderAs(base, "PO-2026-0130", "Received", "2026-09-10T05:00:00.000Z"),
          orderAs(base, "PO-2026-0131", "Cancelled", "2026-09-10T06:00:00.000Z"),
        ],
      });
    });
    const ui = mount(PurchaseOrders);
    for (const o of S().po) expect(ui.ids(columnOf(o.st)), `${o.id} belongs under ${columnOf(o.st)}`).toContain(o.id);
    for (const st of COLUMNS) {
      expect(ui.ids(st)).toHaveLength(S().po.filter((o) => columnOf(o.st) === st).length);
    }
    ui.unmount();
  });

  it("keeps partially and fully received orders in one column, and Show narrows it to either", () => {
    as("buyer");
    const base = S().po[0];
    const partial = orderAs(base, "PO-2026-0130", "Partially received", "2026-09-10T05:00:00.000Z");
    const full = orderAs(base, "PO-2026-0131", "Received", "2026-09-10T06:00:00.000Z");
    act(() => { useApp.setState({ po: [partial, full] }); });
    const ui = mount(PurchaseOrders);
    expect(ui.ids("Received")).toEqual([full.id, partial.id]);
    // Each card says which of the two it is.
    const pills = [...ui.column("Received")!.querySelectorAll(".kan-foot .pill")]
      .map((p) => p.textContent)
      .filter((t) => t !== "Needs finance approval");
    expect(pills).toEqual(["Received", "Partially received"]);

    const show = ui.column("Received")!.querySelector<HTMLSelectElement>("select[aria-label='Show']")!;
    const pick = (v: string) => act(() => {
      show.value = v;
      show.dispatchEvent(new Event("change", { bubbles: true }));
    });
    pick("Partially received");
    expect(ui.ids("Received")).toEqual([partial.id]);
    pick("Fully received");
    expect(ui.ids("Received")).toEqual([full.id]);
    // The other columns are not touched by it.
    expect(ui.column("Draft")!.textContent).not.toContain("Nothing matches those filters");
    pick("All");
    expect(ui.ids("Received")).toEqual([full.id, partial.id]);
    ui.unmount();
  });

  it("opens the order in the right-hand drawer from anywhere on its card", () => {
    as("buyer");
    const draft = FX.seedPo.find((o) => o.st === "Draft")!;
    const ui = mount(PurchaseOrders);
    const card = ui.column("Draft")!.querySelector<HTMLElement>(".kan-card")!;
    act(() => { card.click(); });
    expect(S().drawer).toEqual({ t: "bpo", id: draft.id });
    ui.unmount();
  });

  it("Receive opens the goods receipt, not the order behind the card", () => {
    as("buyer");
    const ordered = FX.seedPo.find((o) => o.st === "Ordered")!;
    const ui = mount(PurchaseOrders);
    const receive = [...ui.column("Ordered")!.querySelectorAll("button")].find((b) => b.textContent === "Receive")!;
    act(() => { receive.click(); });
    expect(S().drawer).toEqual({ t: "bgrn", id: ordered.id });
    ui.unmount();
  });

  it("the drawer shows a closed order's details as well as a live one's", () => {
    as("buyer");
    const base = S().po[0];
    const received = orderAs(base, "PO-2026-0130", "Received", "2026-09-10T05:00:00.000Z");
    const cancelled = orderAs(base, "PO-2026-0131", "Cancelled", "2026-09-10T06:00:00.000Z");
    act(() => { useApp.setState({ po: [...S().po, received, cancelled] }); });
    for (const o of [received, cancelled]) {
      act(() => { S().openDrawer("bpo", o.id); });
      const ui = mount(Drawer);
      expect(ui.host.querySelector(".drawer")).not.toBeNull();
      expect(ui.host.textContent).toContain(o.id);
      expect(ui.host.textContent).not.toContain("Purchase order not found");
      ui.unmount();
    }
  });

  it("says a column is empty because of the filters, and clears them back", () => {
    as("buyer");
    const ui = mount(PurchaseOrders);
    const search = ui.host.querySelector<HTMLInputElement>(".tbar input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "no such order anywhere");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const st of COLUMNS) expect(ui.ids(st)).toEqual([]);
    expect(ui.host.textContent).toContain("Nothing matches those filters");
    const clear = [...ui.host.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!;
    act(() => { clear.click(); });
    expect(ui.ids("Draft")).toEqual(FX.seedPo.filter((o) => o.st === "Draft").map((o) => o.id));
    ui.unmount();
  });
});

describe("a new purchase order is stacked on top of its column", () => {
  it("sorts newest raised first on the instant, never on the printed time or the id", () => {
    // Yesterday 23:40 against today 07:10: the printed time sorts them backwards, and so does
    // PO-…0999 against PO-…1000 as text. Only the instant gets both right.
    const older = { id: "PO-2026-1000", at: "23:40", iso: "2026-09-13T18:10:00.000Z" };
    const newer = { id: "PO-2026-0999", at: "07:10", iso: "2026-09-14T01:40:00.000Z" };
    expect(newestFirst([older, newer]).map((o) => o.id)).toEqual([newer.id, older.id]);
    expect(newestFirst([newer, older]).map((o) => o.id)).toEqual([newer.id, older.id]);
  });

  it("renders the later of two drafts first, and still does after a refetch hands them back oldest first", () => {
    as("buyer");
    const base = FX.seedPo.find((o) => o.st === "Draft")!;
    // As the wire carries them: `at` is the ISO instant, and `applyPos` keeps it as `iso`.
    const wire = (id: string, at: string): PurchaseOrder => ({
      ...clone(base), id, at, eta: "2026-09-20", hist: [{ s: "Draft", who: "Latha Narayanan", t: at }],
    });
    const earlier = wire("PO-2026-1000", "2026-09-13T18:10:00.000Z");
    const later = wire("PO-2026-0999", "2026-09-14T01:40:00.000Z");

    act(() => { applyPos([later, earlier]); });
    const ui = mount(PurchaseOrders);
    expect(ui.ids("Draft")).toEqual([later.id, earlier.id]);

    // The refetch after a write: the same two, now in the opposite order, plus a third raised
    // just now. The newest goes to the top; nothing else moves.
    const newest = wire("PO-2026-1001", "2026-09-14T04:00:00.000Z");
    act(() => { applyPos([earlier, later, newest]); });
    expect(ui.ids("Draft")).toEqual([newest.id, later.id, earlier.id]);
    ui.unmount();
  });
});
