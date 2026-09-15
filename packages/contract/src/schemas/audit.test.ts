import { describe, expect, it } from "vitest";
import { AuditEntrySchema, AuditEventSchema, AuditIdParamsSchema, AuditPageSchema, AuditQuerySchema, AuditRowSchema } from "./audit";

/** A price edit, as the API would put it in the outbox. */
const event = {
  at: "2026-09-14T04:30:00.000Z",
  requestId: "req-7f3a",
  actor: { id: "u3", emp: "RC-3120", name: "Priya Nair", role: "Outlet Manager", loc: "rest" },
  action: "savePrice",
  method: "PUT", path: "/prices/:list/:it",
  target: "A:juice", targetLoc: "",
  outcome: "done",
  status: 200,
  message: "Price list A now sells Real Juice 200ml at ₹20.",
  cause: null,
  request: { params: { list: "A", it: "juice" }, query: {}, body: { price: 20 } },
  before: { price: 19 },
  result: { list: "A", it: "juice", price: 20 },
  changed: ["prices"],
  ip: "10.0.4.17", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0",
} as const;

describe("AuditEventSchema", () => {
  it("accepts a whole event, and an instant written in IST as well as in UTC", () => {
    expect(AuditEventSchema.safeParse(event).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...event, at: "2026-09-14T10:00:00.000+05:30" }).success).toBe(true);
  });

  it("accepts a failed sign-in against an employee number nobody holds", () => {
    const failed = { ...event, action: "login", actor: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
      outcome: "refused", status: 401, cause: "unknown employee", request: {}, before: null, result: null, changed: [] };
    expect(AuditEventSchema.safeParse(failed).success).toBe(true);
  });

  it("refuses an unknown key, so the drainer dead-letters an event built by a newer API rather than dropping a field", () => {
    expect(AuditEventSchema.safeParse({ ...event, surprise: 1 }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, actor: { ...event.actor, admin: true } }).success).toBe(false);
  });

  it("refuses a time that is not an instant, an outcome it does not know and a collection the UI cannot refetch", () => {
    expect(AuditEventSchema.safeParse({ ...event, at: "2026-09-14" }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, outcome: "failed" }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, changed: ["nonsense"] }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, action: "" }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, status: 200.5 }).success).toBe(false);
  });
});

describe("AuditQuerySchema", () => {
  it("answers a bare URL with today's first hundred", () => {
    expect(AuditQuerySchema.parse({})).toEqual({ limit: 100 });
  });

  it("takes the cursor and the page size as the strings a URL spells them in", () => {
    expect(AuditQuerySchema.parse({ before: "42", limit: "500" })).toEqual({ before: 42, limit: 500 });
    expect(AuditQuerySchema.parse({ from: "2026-09-01", to: "2026-09-14", group: "sales", outcome: "refused", q: "CF/1188" }))
      .toEqual({ from: "2026-09-01", to: "2026-09-14", group: "sales", outcome: "refused", q: "CF/1188", limit: 100 });
  });

  it("keeps a page between one and five hundred rows, and a cursor a real id", () => {
    for (const limit of ["0", "501", "1.5", ""]) expect(AuditQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    for (const before of ["0", "-3", "abc"]) expect(AuditQuerySchema.safeParse({ before }).success, before).toBe(false);
  });

  it("refuses a day that is not YYYY-MM-DD, an area it does not have and a key it does not know", () => {
    expect(AuditQuerySchema.safeParse({ from: "14-09-2026" }).success).toBe(false);
    expect(AuditQuerySchema.safeParse({ group: "kitchen" }).success).toBe(false);
    expect(AuditQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
    expect(AuditQuerySchema.safeParse({ surprise: "1" }).success).toBe(false);
  });
});

describe("what the audit service answers with", () => {
  const { method, path, cause, request, before, result, changed, userAgent, ...rest } = event;
  const row = { id: 7, ...rest };
  const entry = { ...row, method, path, cause, request, before, result, changed, userAgent };

  it("reads a row, a page of rows with its counts, and a whole entry", () => {
    expect(AuditPageSchema.safeParse({ rows: [row], next: 6, counts: { events: 12, people: 3, refused: 2, failedSignIns: 1 } }).success).toBe(true);
    expect(AuditPageSchema.safeParse({ rows: [], next: null, counts: { events: 0, people: 0, refused: 0, failedSignIns: 0 } }).success).toBe(true);
    expect(AuditEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("carries the address and the request id on the row itself, because the CSV pages rows", () => {
    const { ip: _ip, ...withoutIp } = row;
    const { requestId: _requestId, ...withoutRequestId } = row;
    expect(AuditRowSchema.safeParse(withoutIp).success).toBe(false);
    expect(AuditRowSchema.safeParse(withoutRequestId).success).toBe(false);
  });

  it("keeps an entry strict, and reads a stored collection name the enum has since dropped", () => {
    expect(AuditEntrySchema.safeParse({ ...entry, surprise: 1 }).success).toBe(false);
    expect(AuditEntrySchema.safeParse({ ...entry, changed: ["retired"] }).success).toBe(true);
  });

  it("takes an entry id from the path as a positive whole number", () => {
    expect(AuditIdParamsSchema.parse({ id: "7" })).toEqual({ id: 7 });
    for (const id of ["0", "abc", "1.5"]) expect(AuditIdParamsSchema.safeParse({ id }).success, id).toBe(false);
  });
});
