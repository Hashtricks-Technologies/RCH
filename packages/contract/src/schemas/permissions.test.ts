import { describe, expect, it } from "vitest";
import { ActionSchema, FeatureSchema, GrantLevelSchema, LevelSchema, PermissionsSchema } from "./permissions";
import { AdminActionSchema, AdminActionsQuerySchema, AdminRoleSchema, AdminUserSchema, CreateRoleBodySchema, RoleIdParamsSchema, UpdateRoleBodySchema } from "./admin";
import { UserSchema } from "./documents";
import { CollectionSchema } from "./writes";
import { act, anyOf, desk, need } from "../routes";

const perms = { f: { prices: "edit", stock_ledger: "view" }, a: ["void_bill"] };

describe("the permission vocabulary", () => {
  it("is a closed catalogue of thirty-four features", () => {
    expect(FeatureSchema.options).toHaveLength(34);
    expect(FeatureSchema.options.slice(0, 5)).toEqual(["billing", "x_report", "z_report", "shift_reports", "credit"]);
    expect(FeatureSchema.safeParse("payroll").success).toBe(false);
  });
  it("has two levels, the editor's none, and three actions", () => {
    expect(LevelSchema.options).toEqual(["view", "edit"]);
    expect(GrantLevelSchema.options).toEqual(["none", "view", "edit"]);
    expect(ActionSchema.options).toEqual(["void_bill", "void_settlement", "all_outlets"]);
  });
});

describe("PermissionsSchema", () => {
  it("takes features at a level and a list of actions", () => {
    expect(PermissionsSchema.parse(perms)).toEqual(perms);
    expect(PermissionsSchema.parse({ f: {}, a: [] })).toEqual({ f: {}, a: [] });
  });
  it("refuses an unknown feature, a level of none, an unknown or repeated action, and a stray key", () => {
    expect(PermissionsSchema.safeParse({ f: { payroll: "edit" }, a: [] }).success).toBe(false);
    expect(PermissionsSchema.safeParse({ f: { prices: "none" }, a: [] }).success).toBe(false);
    expect(PermissionsSchema.safeParse({ f: {}, a: ["refund"] }).success).toBe(false);
    expect(PermissionsSchema.safeParse({ f: {}, a: ["void_bill", "void_bill"] }).success).toBe(false);
    expect(PermissionsSchema.safeParse({ ...perms, extra: 1 }).success).toBe(false);
  });
});

describe("the role wire shapes", () => {
  const role = { id: "ROLE-006", name: "Shift Lead", desk: "counter", active: true, perms, holders: 2, everAssigned: true, updatedAt: "2026-09-24T03:00:00.000Z" };
  it("describes a role as the admin page lists it", () => {
    expect(AdminRoleSchema.parse(role)).toEqual(role);
    expect(AdminRoleSchema.safeParse({ ...role, desk: "admin" }).success).toBe(false);
    expect(AdminRoleSchema.safeParse({ ...role, holders: -1 }).success).toBe(false);
  });
  it("creates a role from a name, a desk and permissions, and nothing else", () => {
    expect(CreateRoleBodySchema.parse({ name: "  Shift Lead ", desk: "counter", perms })).toEqual({ name: "Shift Lead", desk: "counter", perms });
    expect(CreateRoleBodySchema.safeParse({ name: "S", desk: "counter", perms }).success).toBe(false);
    expect(CreateRoleBodySchema.safeParse({ id: "ROLE-009", name: "Shift Lead", desk: "counter", perms }).success).toBe(false);
  });
  it("patches any field without resetting the ones left out", () => {
    expect(UpdateRoleBodySchema.parse({})).toEqual({});
    expect(UpdateRoleBodySchema.parse({ name: "Senior Cashier" })).toEqual({ name: "Senior Cashier" });
    expect(UpdateRoleBodySchema.safeParse({ active: false }).success).toBe(false);
  });
  it("names a role by its id", () => {
    expect(RoleIdParamsSchema.parse({ id: "ROLE-001" })).toEqual({ id: "ROLE-001" });
    expect(RoleIdParamsSchema.safeParse({ id: "" }).success).toBe(false);
  });
});

describe("the fields roles add to what already travels", () => {
  const user = { id: "u1", n: "Anitha", e: "a@x", r: "counter", rl: "Counter Operator", loc: "coffee", col: "#000", emp: "RC-4471", ph: "", admin: false };
  it("carries the caller's role and permissions, both absent for the super admin", () => {
    expect(UserSchema.parse({ ...user, rid: "ROLE-001", perms })).toMatchObject({ rid: "ROLE-001", perms });
    expect(UserSchema.parse(user)).not.toHaveProperty("perms");
    expect(UserSchema.safeParse({ ...user, perms: { f: { payroll: "view" }, a: [] } }).success).toBe(false);
  });
  it("lists an account's role on the admin page", () => {
    const admin = { id: "u1", emp: "RC-4471", n: "Anitha", e: "a@x", ph: "", r: "counter", rl: "Counter Operator", loc: "coffee", col: "#000", active: true, mustChangePassword: false, admin: false };
    expect(AdminUserSchema.parse({ ...admin, rid: "ROLE-001" }).rid).toBe("ROLE-001");
    expect(AdminUserSchema.parse(admin).rid).toBeUndefined();
  });
  it("logs the five role actions, reads them as their own tab, and announces roles", () => {
    for (const a of ["role_create", "role_update", "role_deactivate", "role_reactivate", "role_delete"]) {
      expect(AdminActionSchema.shape.action.safeParse(a).success, a).toBe(true);
    }
    expect(AdminActionsQuerySchema.parse({ kind: "roles" })).toEqual({ kind: "roles" });
    expect(CollectionSchema.safeParse("roles").success).toBe(true);
  });
});

describe("the access helpers", () => {
  it("build the needs a route is reached by", () => {
    expect(need("prices", "edit")).toEqual({ needs: [{ f: "prices", l: "edit" }] });
    expect(act("void_bill")).toEqual({ needs: [{ a: "void_bill" }] });
    expect(anyOf(need("approvals", "edit"), { f: "outlet_stock", l: "edit" }, act("void_bill"))).toEqual({
      needs: [{ f: "approvals", l: "edit" }, { f: "outlet_stock", l: "edit" }, { a: "void_bill" }],
    });
    expect(desk("counter")).toEqual({ desk: ["counter"] });
  });
});
