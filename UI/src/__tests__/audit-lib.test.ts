import { describe, expect, it } from "vitest";
import { AUDIT_GROUPS, auditLabelOf } from "@rch/contract";
import {
  AUDIT_ROLE_LABELS, auditCsv, auditDayRange, deviceOf, diffFields, placeOf,
} from "../lib/audit";
import { fromWireSeconds, fromWireStamp } from "../lib/fmt";
import type { AuditRow } from "../types";

/**
 * The audit log's pure helpers. This suite runs with TZ=UTC, so every day and clock below is
 * the hospital's (Asia/Kolkata) only because the helpers make it so: 18:30 UTC is IST midnight.
 */

const NOTHING = { from: "", to: "" };
const LAST_SECOND_OF_13TH = new Date("2026-09-13T18:29:59.000Z");   // 23:59:59 on the 13th in IST
const MIDNIGHT_14TH = new Date("2026-09-13T18:30:00.000Z");         // 00:00:00 on the 14th in IST

describe("auditDayRange", () => {
  it("names today by the hospital's midnight, not the host's", () => {
    expect(auditDayRange("today", NOTHING, LAST_SECOND_OF_13TH)).toEqual({ from: "2026-09-13", to: "2026-09-13" });
    expect(auditDayRange("today", NOTHING, MIDNIGHT_14TH)).toEqual({ from: "2026-09-14", to: "2026-09-14" });
  });

  it("counts 7 and 30 days back, today included", () => {
    expect(auditDayRange("7d", NOTHING, MIDNIGHT_14TH)).toEqual({ from: "2026-09-08", to: "2026-09-14" });
    expect(auditDayRange("30d", NOTHING, MIDNIGHT_14TH)).toEqual({ from: "2026-08-16", to: "2026-09-14" });
    expect(auditDayRange("30d", NOTHING, LAST_SECOND_OF_13TH)).toEqual({ from: "2026-08-15", to: "2026-09-13" });
  });

  it("takes a custom range as typed, fills a missing end from the other, and turns a backwards one round", () => {
    expect(auditDayRange("custom", { from: "2026-09-01", to: "2026-09-10" }, MIDNIGHT_14TH)).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(auditDayRange("custom", { from: "2026-09-01", to: "" }, MIDNIGHT_14TH)).toEqual({ from: "2026-09-01", to: "2026-09-01" });
    expect(auditDayRange("custom", { from: "", to: "2026-09-05" }, MIDNIGHT_14TH)).toEqual({ from: "2026-09-05", to: "2026-09-05" });
    expect(auditDayRange("custom", { from: "2026-09-10", to: "2026-09-01" }, MIDNIGHT_14TH)).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(auditDayRange("custom", NOTHING, MIDNIGHT_14TH)).toEqual({ from: "2026-09-14", to: "2026-09-14" });
  });
});

describe("the audit log's clock", () => {
  it("prints an instant to the second in IST, and as one sortable cell for a spreadsheet", () => {
    expect(fromWireSeconds("2026-09-13T18:30:05.000Z")).toBe("00:00:05");
    expect(fromWireSeconds("2026-09-14T04:12:09.000Z")).toBe("09:42:09");
    expect(fromWireStamp("2026-09-13T18:30:05.000Z")).toBe("2026-09-14 00:00:05");
    expect(fromWireStamp("2026-09-13T18:29:59.000Z")).toBe("2026-09-13 23:59:59");
    expect(fromWireStamp("not a time")).toBe("not a time");
  });
});

describe("deviceOf", () => {
  const cases: [ua: string, device: string][] = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1", "Safari on iOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1", "Chrome on iOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15", "Firefox on iOS"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "Samsung Internet on Android"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.60", "Edge on Android"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) SomeTool/1.0", "Unknown browser on Windows"],
    ["curl/8.7.1", "Unknown device"],
    ["", "Unknown device"],
  ];
  for (const [ua, device] of cases) {
    it(device + (ua ? "" : " (no user agent)"), () => { expect(deviceOf(ua)).toBe(device); });
  }
});

describe("diffFields", () => {
  it("names only the fields the edit changed, comparing lists by their contents", () => {
    expect(diffFields(
      { mrp: 50, cost: 30, n: "Orange juice", groups: ["a", "b"] },
      { c: "juice", mrp: 45, cost: 30, n: "Orange juice", groups: ["a", "b"], u: "nos" },
    )).toEqual([{ field: "mrp", before: 50, after: 45 }]);
    expect(diffFields({ groups: ["a"] }, { groups: ["a", "b"] })).toEqual([{ field: "groups", before: ["a"], after: ["a", "b"] }]);
  });

  it("looks one level into a nested object and names what changed there by its path", () => {
    expect(diffFields(
      { item: { cost: 30, n: "Juice", tags: ["cold"], unit: { u: "nos" } } },
      { item: { cost: 35, n: "Juice", tags: ["cold"], unit: { u: "nos" } }, extra: 1 },
    )).toEqual([{ field: "item.cost", before: 30, after: 35 }]);
  });

  it("compares everything else strictly, so null against a missing field is a change", () => {
    expect(diffFields({ note: null }, {})).toEqual([{ field: "note", before: null, after: undefined }]);
    expect(diffFields({ item: { cost: 30 } }, { item: null })).toEqual([{ field: "item", before: { cost: 30 }, after: null }]);
  });

  it("has nothing to compare unless both sides are plain objects", () => {
    expect(diffFields(null, { a: 1 })).toEqual([]);
    expect(diffFields({ a: 1 }, null)).toEqual([]);
    expect(diffFields([1], [2])).toEqual([]);
  });
});

describe("places and roles", () => {
  it("prints a stored location by name, an unknown one as stored, and none as a hyphen", () => {
    expect(placeOf("coffee")).toBe("Coffee Shop");
    expect(placeOf("quarantine")).toBe("quarantine");
    expect(placeOf("")).toBe("-");
  });

  it("offers exactly the role words an event is stored with", () => {
    expect(AUDIT_ROLE_LABELS).toEqual(["Counter Operator", "Outlet Manager", "Store Keeper", "Kitchen In-charge", "Procurement Officer", "Super Admin"]);
  });
});

describe("auditCsv", () => {
  const row = (over: Partial<AuditRow> = {}): AuditRow => ({
    id: 1, at: "2026-09-13T18:30:05.000Z",
    actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
    action: "savePrice", target: "A:juice", targetLoc: "", outcome: "done", status: 200,
    message: "Price saved", ip: "10.0.0.7", requestId: "req-1", ...over,
  });

  it("writes the header, one line per event with its IST time, and CRLF line ends", () => {
    const lines = auditCsv([row()]).split("\r\n");
    expect(lines[0]).toBe("at (IST),emp,name,role,location,area,action,target,outcome,status,message,ip,request id");
    const { label, group } = auditLabelOf("savePrice", "done");
    expect(lines[1]).toBe(
      `2026-09-14 00:00:05,RC-3120,Ramesh Kumar,Outlet Manager,rest,${group ? AUDIT_GROUPS[group] : ""},${label},A:juice,Done,200,Price saved,10.0.0.7,req-1`,
    );
    expect(lines).toEqual([lines[0], lines[1], ""]);
    expect(auditCsv([])).toBe("at (IST),emp,name,role,location,area,action,target,outcome,status,message,ip,request id\r\n");
  });

  it("quotes commas, quotes and line breaks the RFC 4180 way, and never hands a spreadsheet a formula", () => {
    const csv = auditCsv([row({
      action: "login", outcome: "refused", status: 401,
      actor: { id: null, emp: "RC-9,9", name: "", role: "", loc: "" },
      target: '=HYPERLINK("x")',
      message: 'Refused - the "A" list, above MRP\nsee the note',
    })]);
    const body = csv.slice(csv.indexOf("\r\n") + 2);
    expect(body).toContain('"RC-9,9"');
    expect(body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(body).toContain('"Refused - the ""A"" list, above MRP\nsee the note"');
    expect(body).toContain(",Failed sign-in,");
    expect(body).toContain(",Refused,401,");
  });
});
