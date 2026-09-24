import { describe, expect, it } from "vitest";
import { AUDIT_GROUP_KEYS } from "./schemas/audit";
import { AUDIT_GROUPS, AUDIT_LABELS, AUDIT_PATH, actionsInGroup, auditLabelOf, type AuditAction, type WriteRouteName } from "./audit";
import { isWriteRoute, routes, serviceOf } from "./routes";

const AUTH_ACTIONS = ["login", "logout", "changePassword"];
const SYSTEM_ACTIONS = ["qrOrderPaid", "qrOrderRefunded", "qrRefundSent", "qrRefundProcessed", "qrRefundFailed"];

describe("AUDIT_LABELS", () => {
  it("labels exactly the writes the API answers, plus sign-in, sign-out, a password change and the system's own", () => {
    // The runtime twin of `Record<AuditAction, AuditLabel>`: the type catches a missing label at
    // typecheck, this catches a route whose `write` flag and method disagree with the type's reading.
    const writes = Object.entries(routes).filter(([, r]) => isWriteRoute(r) && serviceOf(r) === "api").map(([name]) => name);
    expect(Object.keys(AUDIT_LABELS).sort()).toEqual([...writes, ...AUTH_ACTIONS, ...SYSTEM_ACTIONS].sort());
  });

  it("gives every action a label of its own, so the table and the CSV never print two actions alike", () => {
    const labels = Object.values(AUDIT_LABELS).map((l) => l.label);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("keeps reads, the token refresh and the audit service's own routes out of the type", () => {
    const writes: WriteRouteName[] = ["pay", "patchMe", "savePrice", "deleteAdminUser"];
    const actions: AuditAction[] = [...writes, "login", "logout", "changePassword", "qrOrderPaid", "qrRefundFailed"];
    const notActions: AuditAction[] = [
      // @ts-expect-error - a GET is a read, and reads are not audited
      "snapshot",
      // @ts-expect-error - an automatic token refresh is not an event
      "refresh",
      // @ts-expect-error - reading the log is not an event in it
      "auditLog",
      // @ts-expect-error - a customer reading their order's status is a read
      "publicQrOrder",
    ];
    expect(actions.every((a) => a in AUDIT_LABELS)).toBe(true);
    expect(notActions.some((a) => a in AUDIT_LABELS)).toBe(false);
  });
});

describe("AUDIT_GROUPS", () => {
  it("prints every area the filter offers, and every area holds at least one action", () => {
    expect(Object.keys(AUDIT_GROUPS).sort()).toEqual([...AUDIT_GROUP_KEYS].sort());
    for (const g of AUDIT_GROUP_KEYS) expect(actionsInGroup(g).length, g).toBeGreaterThan(0);
  });

  it("puts every action in exactly one area", () => {
    const grouped = AUDIT_GROUP_KEYS.flatMap((g) => actionsInGroup(g));
    expect(grouped.sort()).toEqual(Object.keys(AUDIT_LABELS).sort());
  });

  it("files sign-in with accounts and a bill with sales", () => {
    expect(actionsInGroup("accounts")).toEqual(expect.arrayContaining(["login", "logout", "changePassword", "createAdminUser"]));
    expect(actionsInGroup("sales").sort()).toEqual([
      "closeRegister", "closeShift", "createQrOrder", "pay", "qrOrderPaid", "qrOrderRefunded", "qrRefundFailed", "qrRefundProcessed", "qrRefundSent",
      "recordSettlement", "retryQrRefund", "setQrOrderStatus", "setQrPause", "toggleAvail", "verifyQrPayment", "voidBill", "voidSettlement",
    ]);
  });

  it("files every role write under roles & permissions", () => {
    expect(actionsInGroup("roles").sort()).toEqual(["createRole", "deactivateRole", "deleteRole", "reactivateRole", "updateRole"]);
    expect(AUDIT_GROUPS.roles).toBe("Roles & permissions");
  });
});

describe("auditLabelOf", () => {
  it("prints an action's label and area", () => {
    expect(auditLabelOf("pay", "done")).toEqual({ label: "Posted a bill", group: "sales" });
    expect(auditLabelOf("savePrice", "error")).toEqual({ label: "Changed a price", group: "master" });
  });

  it("prints a refused sign-in as a failed one, and leaves every other refusal on its own label", () => {
    expect(auditLabelOf("login", "done")).toEqual({ label: "Signed in", group: "accounts" });
    expect(auditLabelOf("login", "refused")).toEqual({ label: "Failed sign-in", group: "accounts" });
    expect(auditLabelOf("pay", "refused")).toEqual({ label: "Posted a bill", group: "sales" });
  });

  it("prints an action nobody labels any more as itself, in no area", () => {
    expect(auditLabelOf("retiredWrite", "done")).toEqual({ label: "retiredWrite", group: null });
    // Not a label inherited from Object.prototype.
    expect(auditLabelOf("constructor", "done")).toEqual({ label: "constructor", group: null });
  });
});

describe("AUDIT_PATH", () => {
  it("holds every route the audit service answers and none the API does, so one proxy rule splits the two", () => {
    const under = Object.entries(routes).filter(([, r]) => r.path.startsWith(AUDIT_PATH));
    expect(under.map(([name]) => name).sort()).toEqual(["auditEntry", "auditLog"]);
    for (const [name, r] of under) expect(serviceOf(r), name).toBe("audit");
  });
});
