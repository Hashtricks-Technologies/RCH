CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"desk" "role" NOT NULL,
	"perms" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"ever_assigned" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_id_desk_uq" UNIQUE("id","desk")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_uq" ON "roles" USING btree (lower("name"));--> statement-breakpoint
-- The five roles every hospital starts with, one per desk, holding exactly what that desk could
-- reach before roles were configurable (`DESK_DEFAULTS` in @rch/domain, from which this literal was
-- generated) - except `z_report`, which nobody holds until the super admin gives it. Invisible to
-- drizzle-kit, which diffs schema and not data. `ever_assigned` is true: every existing account is
-- put onto one of them below, and on a bare hospital they are the roles its first staff are given.
-- ROLE-006 onward are the super admin's (`SEQUENCE_START.role`, handed out by `ensureSequences`).
INSERT INTO "roles" ("id", "name", "desk", "perms", "active", "ever_assigned") VALUES
  ('ROLE-001', 'Counter Operator', 'counter', '{"f":{"billing":"edit","availability":"edit","item_photos":"edit","outlet_stock":"edit","outlet_requests":"edit","outlet_tickets":"edit","x_report":"view"},"a":[]}'::jsonb, true, true),
  ('ROLE-002', 'Outlet Manager', 'manager', '{"f":{"billing":"view","x_report":"view","shift_reports":"view","stock_ledger":"view","credit":"edit","settlements":"edit","approvals":"edit","items_stock":"edit","menu":"edit","prices":"edit","availability":"edit","item_photos":"edit"},"a":["void_bill","void_settlement","all_outlets"]}'::jsonb, true, true),
  ('ROLE-003', 'Store Keeper', 'store', '{"f":{"issue_desk":"edit","store_requisitions":"edit","adjustments":"edit","goods_receipt":"edit","item_master":"edit","store_stock":"view","store_reports":"view","stock_ledger":"view"},"a":[]}'::jsonb, true, true),
  ('ROLE-004', 'Kitchen In-charge', 'prod', '{"f":{"kitchen_orders":"edit","make_distribute":"edit","kitchen_requests":"edit","kitchen_tickets":"edit","availability":"edit","adjustments":"edit","item_master":"edit","kitchen_stock":"view","stock_ledger":"view"},"a":[]}'::jsonb, true, true),
  ('ROLE-005', 'Procurement Officer', 'buyer', '{"f":{"requisitions":"edit","procurement_list":"edit","purchase_orders":"edit","rate_contracts":"edit","vendors":"edit","goods_receipt":"edit","item_master":"edit","new_products":"edit","inventory":"view","stock_ledger":"view"},"a":[]}'::jsonb, true, true);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" text;--> statement-breakpoint
-- Every account but the super admin's onto its desk's role; the label follows the role's name,
-- which is what it already said. The super admin holds no role.
UPDATE "users" SET "role_id" = "roles"."id", "role_label" = "roles"."name"
FROM "roles"
WHERE "roles"."desk" = "users"."role" AND "roles"."id" IN ('ROLE-001', 'ROLE-002', 'ROLE-003', 'ROLE-004', 'ROLE-005') AND NOT "users"."admin";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_desk_fk" FOREIGN KEY ("role_id","role") REFERENCES "roles"("id","desk") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_ck" CHECK ("users"."admin" or "users"."role_id" is not null);
