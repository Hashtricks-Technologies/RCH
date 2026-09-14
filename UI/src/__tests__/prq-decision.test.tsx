import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { prqDecision } from "../lib/selectors";
import Drawer from "../ui/Drawer";
import StoreDashboard from "../roles/store/Dashboard";
import StoreRequisitions from "../roles/store/Requisitions";
import BuyerRequisitions from "../roles/buyer/Requisitions";
import "../roles/store/RequisitionDetail";       // registers "sprq"
import "../roles/buyer/RequisitionDrawer";       // registers "bprq"
import type { DatedDoc, Requisition } from "../types";
import { useApp } from "../store";
import { as, resetStore, S } from "./fixture";

/**
 * The buyer's decision note, delivered.
 *
 * The bug behind this file: a requisition declined — or approved in part — with a reason kept the
 * reason on the server and on the wire, but no screen put it in front of the store keeper. Their
 * panel's red DECLINED banner printed the store keeper's *own* note back at them, the buyer's
 * reason sat under two tables at the foot of the panel, the history said only who and when, their
 * list and their dashboard never mentioned it at all, and the buyer's note box promised the reason
 * was "kept on the requisition history" when the history never showed it.
 */

beforeEach(resetStore);
// Unmounted here rather than at the end of each test: an assertion that fails first would leave
// the panel mounted, re-rendering on every later test's state.
const mounted: (() => void)[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!(); });

const REASON = "Vendor out of stock until next month";
const ASK = "Store keeper's own ask for the week";

/** A requisition the buyer declined, its decision stamped at `decidedIso`. */
const declinedAt = (id: string, decidedIso: string): DatedDoc<Requisition> => ({
  id, by: "Suresh Muthu", at: "16:40", iso: new Date(Date.parse(decidedIso) - 60_000).toISOString(),
  st: "Declined", note: ASK, apprBy: "Latha Narayanan", apprNote: REASON,
  lines: [{ it: "milk", qty: 5, appr: 0, ordered: 0, short: 5 }],
  hist: [
    { s: "Sent", who: "Suresh Muthu", t: "16:40", iso: new Date(Date.parse(decidedIso) - 60_000).toISOString() },
    { s: "Declined", who: "Latha Narayanan", t: "16:48", iso: decidedIso },
  ],
});
const JUST_NOW = () => new Date(Date.now() - 1_000).toISOString();
const DAY_BEFORE = () => new Date(Date.now() - 36 * 3600_000).toISOString();

const addPrq = (...p: DatedDoc<Requisition>[]) => act(() => { useApp.setState({ prq: [...S().prq, ...p] }); });

function mount(node: ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(node))); });
  let live = true;
  const unmount = () => { if (!live) return; live = false; act(() => { root.unmount(); }); host.remove(); };
  mounted.push(unmount);
  return {
    host,
    text: () => host.textContent ?? "",
    /** Every alert banner, as its label and its text. */
    alerts: () => [...host.querySelectorAll<HTMLElement>(".al")].map((a) => ({
      label: a.querySelector(".k")?.textContent ?? "", text: a.textContent ?? "", el: a,
    })),
    unmount,
  };
}
const openPanel = (t: "sprq" | "bprq", id: string) => {
  const ui = mount(Drawer);
  act(() => { S().openDrawer(t, id); });
  return ui;
};
const search = (host: HTMLElement, placeholder: string, v: string) => {
  const el = host.querySelector<HTMLInputElement>(`input[placeholder^="${placeholder}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
/** The history feed's entries, title and body. */
const trail = (host: HTMLElement) => [...host.querySelectorAll(".feed .fi")].map((f) => f.textContent ?? "");

describe("prqDecision", () => {
  it("is nothing while the requisition is still with procurement", () => {
    expect(prqDecision(S().prq.find((p) => p.st === "Sent")!)).toBeNull();
  });

  it("reads who decided, which way, the note and when, off the trail entry that decided it", () => {
    const iso = JUST_NOW();
    const d = prqDecision(declinedAt("PRQ-2026-020", iso))!;
    expect(d).toMatchObject({ st: "Declined", by: "Latha Narayanan", note: REASON, at: "16:48", iso, entry: 1 });
  });

  it("trims the note, and gives an empty one rather than a missing one", () => {
    const p = { ...declinedAt("PRQ-2026-020", JUST_NOW()), apprNote: "   " };
    expect(prqDecision(p)!.note).toBe("");
    expect(prqDecision({ ...p, apprNote: undefined })!.note).toBe("");
  });
});

describe("the store keeper's requisition panel", () => {
  it("leads with the buyer's reason, not the store keeper's own note", () => {
    as("store");
    addPrq(declinedAt("PRQ-2026-020", JUST_NOW()));
    const ui = openPanel("sprq", "PRQ-2026-020");
    const [first] = ui.alerts();
    expect(first.label).toBe("DECLINED");
    expect(first.text).toContain("Latha Narayanan");
    expect(first.text).toContain(REASON);
    expect(first.text).not.toContain(ASK);
    // The ask is still there, and says whose words it is.
    expect(ui.text()).toContain(`Note sent with it: ${ASK}`);
    ui.unmount();
  });

  it("does not call a declined line trimmed, or not yet ordered", () => {
    as("store");
    addPrq(declinedAt("PRQ-2026-020", JUST_NOW()));
    const ui = openPanel("sprq", "PRQ-2026-020");
    expect(ui.text()).not.toMatch(/trimmed/i);
    expect(ui.text()).not.toContain("Not ordered");
    expect(ui.text()).toContain("Not approved");
    ui.unmount();
  });

  it("puts the reason on the history entry that declined it", () => {
    as("store");
    addPrq(declinedAt("PRQ-2026-020", JUST_NOW()));
    const ui = openPanel("sprq", "PRQ-2026-020");
    const entries = trail(ui.host);
    expect(entries[1]).toContain("Declined");
    expect(entries[1]).toContain(REASON);
    expect(entries[0]).not.toContain(REASON);
    ui.unmount();
  });

  it("leads a part-approval with the buyer's note and what was trimmed", () => {
    as("store");
    const ui = openPanel("sprq", "PRQ-2026-014");
    const [first] = ui.alerts();
    expect(first.label).toBe("PARTIALLY APPROVED");
    expect(first.text).toContain("Sugar trimmed — last lot is still moving.");
    expect(ui.text()).toMatch(/Trimmed: Sugar, refined short 10\.000 kg/);
    ui.unmount();
  });

  it("says so when the decision carried no note", () => {
    as("store");
    addPrq({ ...declinedAt("PRQ-2026-020", JUST_NOW()), apprNote: "" });
    const ui = openPanel("sprq", "PRQ-2026-020");
    expect(ui.alerts()[0].text).toContain("No note was left with the decision.");
    ui.unmount();
  });
});

describe("the buyer's requisition panel", () => {
  it("leads a decided requisition with the decision and its note", () => {
    as("buyer");
    addPrq(declinedAt("PRQ-2026-020", JUST_NOW()));
    const ui = openPanel("bprq", "PRQ-2026-020");
    const [first, second] = ui.alerts();
    expect(first.label).toBe("DECLINED");
    expect(first.text).toContain(REASON);
    // The store keeper's requirement no longer wears the decision's label.
    expect(second.label).not.toBe("DECLINED");
    expect(second.text).toContain(ASK);
    expect(trail(ui.host)[1]).toContain(REASON);
    ui.unmount();
  });

  it("shows no decision on a requisition still waiting on the buyer", () => {
    as("buyer");
    const ui = openPanel("bprq", "PRQ-2026-013");
    expect(ui.alerts().map((a) => a.label)).not.toContain("DECLINED");
    expect(ui.text()).toContain("Milk at zero in the coffee shop");
    ui.unmount();
  });
});

describe("the store keeper's requisition list", () => {
  it("prints the reason beside a declined requisition, and finds it by the reason", () => {
    as("store");
    addPrq(declinedAt("PRQ-2026-020", JUST_NOW()));
    const ui = mount(StoreRequisitions);
    const row = [...ui.host.querySelectorAll("tr")].find((r) => r.textContent?.includes("PRQ-2026-020"))!;
    expect(row.textContent).toContain(REASON);
    search(ui.host, "Search requisition", "out of stock until");
    const ids = [...ui.host.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "");
    expect(ids.some((t) => t.includes("PRQ-2026-020"))).toBe(true);
    expect(ids.some((t) => t.includes("PRQ-2026-015"))).toBe(false);
    ui.unmount();
  });
});

describe("the store keeper's dashboard", () => {
  it("raises today's declined requisition with the buyer's reason, and opens it", () => {
    as("store");
    addPrq(declinedAt("PRQ-2026-020", JUST_NOW()));
    const ui = mount(StoreDashboard);
    const a = ui.alerts().find((x) => x.label === "DECLINED")!;
    expect(a, "a DECLINED alert").toBeTruthy();
    expect(a.text).toContain("PRQ-2026-020");
    expect(a.text).toContain("Latha Narayanan");
    expect(a.text).toContain(REASON);
    const open = [...a.el.querySelectorAll("button")].find((b) => b.textContent === "Open")!;
    act(() => { open.click(); });
    expect(S().drawer).toEqual({ t: "sprq", id: "PRQ-2026-020" });
    ui.unmount();
  });

  it("raises today's part-approval with its note", () => {
    as("store");
    const ui = mount(StoreDashboard);
    const a = ui.alerts().find((x) => x.label === "TRIMMED")!;
    expect(a, "a TRIMMED alert").toBeTruthy();
    expect(a.text).toContain("PRQ-2026-014");
    expect(a.text).toContain("Sugar trimmed — last lot is still moving.");
    ui.unmount();
  });

  it("leaves out a decision from an earlier day and an approval in full", () => {
    as("store");
    addPrq(declinedAt("PRQ-2026-021", DAY_BEFORE()));
    const ui = mount(StoreDashboard);
    const text = ui.alerts().map((a) => a.text).join(" | ");
    expect(text).not.toContain("PRQ-2026-021");
    expect(text).not.toContain("PRQ-2026-015");     // approved in full today
    ui.unmount();
  });
});

describe("the buyer's requisition list", () => {
  it("prints the note beside a part-approval", () => {
    as("buyer");
    const ui = mount(BuyerRequisitions);
    const row = [...ui.host.querySelectorAll("tr")].find((r) => r.textContent?.includes("PRQ-2026-014"))!;
    expect(row.textContent).toContain("Sugar trimmed — last lot is still moving.");
    ui.unmount();
  });
});
