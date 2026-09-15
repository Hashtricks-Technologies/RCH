import { AUDIT_GROUPS, auditLabelOf } from "@rch/contract";
import { istDate } from "@rch/domain";
import { fromWireStamp } from "./fmt";
import type { AuditOutcome, AuditRow, LocKey, Tone } from "../types";

/**
 * The audit log's browser-side helpers (spec 5.2): the IST days a period stands for, the device a
 * user agent names, what an edit changed, and the CSV an export hands over. All pure, so the
 * suite drives each one without rendering the tab.
 */

export type AuditPeriod = "today" | "7d" | "30d" | "custom";

const DAY_MS = 86_400_000;
const WIRE_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** `n` hospital days before `day`. India keeps no daylight saving, so a day is always 24 hours. */
const daysBefore = (day: string, n: number): string =>
  istDate(new Date(Date.parse(`${day}T00:00:00+05:30`) - n * DAY_MS));

/**
 * The IST days a period covers, as the `from` / `to` the audit service takes. "Today" is the
 * hospital's today (`istDate`), not the host's, and "7 days" is today and the six before it. A
 * custom range takes what was typed: a missing end is the other end, nothing typed is today, and
 * a range typed backwards is turned the right way round rather than refused.
 */
export function auditDayRange(
  period: AuditPeriod, custom: { from: string; to: string }, now: Date = new Date(),
): { from: string; to: string } {
  const today = istDate(now);
  if (period === "today") return { from: today, to: today };
  if (period === "7d") return { from: daysBefore(today, 6), to: today };
  if (period === "30d") return { from: daysBefore(today, 29), to: today };
  const typed = (d: string) => (WIRE_DAY.test(d) ? d : null);
  const from = typed(custom.from) ?? typed(custom.to) ?? today;
  const to = typed(custom.to) ?? from;
  return from <= to ? { from, to } : { from: to, to: from };
}

/* Order matters in both tables: Edge and Samsung Internet also say "Chrome", Chrome and Firefox
   on iOS also say "Safari", an iPad says "like Mac OS X", and Android and ChromeOS say "Linux". */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/\bWindows\b/, "Windows"],
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];
const firstMatch = (ua: string, table: [RegExp, string][]): string | null =>
  table.find(([re]) => re.test(ua))?.[1] ?? null;

/** "Chrome on Windows", from the user agent an event was sent with. No dependency: an audit log
 *  needs the family and the platform, not the version. */
export function deviceOf(userAgent: string): string {
  const browser = firstMatch(userAgent, BROWSERS);
  const system = firstMatch(userAgent, SYSTEMS);
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `Unknown browser on ${system}`;
  return "Unknown device";
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);
/** One stored value against another. A list, or an object below the level `diffFields` opens,
 *  is compared by its JSON, so lines saved unchanged are not reported as an edit. Anything else
 *  is compared strictly: `null` and a missing field are two different values. */
const same = (a: unknown, b: unknown): boolean =>
  a === b
  || (typeof a === "object" && typeof b === "object" && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

/**
 * The fields an edit changed: every field `before` holds whose value differs from the same field
 * of `after`. Where both sides of a field are plain objects, it looks one level in and names each
 * changed field by its path ("item.cost"). `before` carries only what the edit could alter
 * (`auditBefore` on the server), so the document's other fields, which `after` also carries, are
 * never reported. Anything that is not a plain object on both sides has nothing to compare.
 */
export function diffFields(before: unknown, after: unknown): Array<{ field: string; before: unknown; after: unknown }> {
  if (!isPlain(before) || !isPlain(after)) return [];
  const changed: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const [field, was] of Object.entries(before)) {
    const now = after[field];
    if (isPlain(was) && isPlain(now)) {
      for (const [inner, innerWas] of Object.entries(was)) {
        if (!same(innerWas, now[inner])) changed.push({ field: `${field}.${inner}`, before: innerWas, after: now[inner] });
      }
    } else if (!same(was, now)) {
      changed.push({ field, before: was, after: now });
    }
  }
  return changed;
}

/** An outcome's printed word and pill tone: the table, the drawer and the CSV all use these. */
export const AUDIT_OUTCOME_LABEL: Record<AuditOutcome, string> = { done: "Done", refused: "Refused", error: "Error" };
export const AUDIT_OUTCOME_TONE: Record<AuditOutcome, Tone> = { done: "ok", refused: "wn", error: "cr" };

/** The role words an event is stored with: the account's role label, or "Super Admin" for the
 *  flagged account (`roleLabelOf`, apps/api/src/lib/wire.ts). The Role filter sends exactly these. */
export const AUDIT_ROLE_LABELS = [
  "Counter Operator", "Outlet Manager", "Store Keeper", "Kitchen In-charge", "Procurement Officer", "Super Admin",
] as const;

/** Place names for the admin page. It loads no snapshot, so there is no `LOC` registry to read.
 *  This is the same display map `AdminUsers` and `AdminSupport` keep. */
export const AUDIT_PLACES: Record<LocKey, string> = {
  store: "Central Store", kitchen: "Central Kitchen", rest: "Restaurant", coffee: "Coffee Shop", kiosk: "Snack Kiosk",
};
/** A stored location as its name. An unknown one prints as stored, and none at all as "-". */
export const placeOf = (loc: string): string =>
  loc === "" ? "-" : Object.hasOwn(AUDIT_PLACES, loc) ? AUDIT_PLACES[loc as LocKey] : loc;

const CSV_HEADER = ["at (IST)", "emp", "name", "role", "location", "area", "action", "target", "outcome", "status", "message", "ip", "request id"];

/** One RFC 4180 field. Text that a spreadsheet would run as a formula gets a leading apostrophe,
 *  because the log carries what people typed: a vendor name, a note, an employee id. */
const csvCell = (v: string | number): string => {
  if (typeof v === "number") return String(v);
  const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The export: a header, then one CRLF-terminated line per event, time in IST. */
export function auditCsv(rows: AuditRow[]): string {
  const lines = rows.map((r) => {
    const { label, group } = auditLabelOf(r.action, r.outcome);
    return [
      fromWireStamp(r.at), r.actor.emp, r.actor.name, r.actor.role, r.actor.loc,
      group ? AUDIT_GROUPS[group] : "", label, r.target, AUDIT_OUTCOME_LABEL[r.outcome],
      r.status, r.message, r.ip, r.requestId,
    ].map(csvCell).join(",");
  });
  return [CSV_HEADER.join(","), ...lines].map((line) => `${line}\r\n`).join("");
}
