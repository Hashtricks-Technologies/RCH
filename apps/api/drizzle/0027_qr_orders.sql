CREATE TYPE "bill_source" AS ENUM('till', 'qr');--> statement-breakpoint
CREATE TYPE "qr_mode" AS ENUM('pickup', 'deliver');--> statement-breakpoint
CREATE TYPE "qr_order_status" AS ENUM('Awaiting payment', 'Paid', 'Preparing', 'Ready', 'Out for delivery', 'Collected', 'Delivered', 'Refunded', 'Expired', 'Voided');--> statement-breakpoint
CREATE TYPE "refund_reason" AS ENUM('unfulfillable', 'void', 'duplicate');--> statement-breakpoint
CREATE TYPE "refund_status" AS ENUM('Pending', 'Sent', 'Processed', 'Failed');--> statement-breakpoint
CREATE TABLE "outlet_order_hours" (
	"loc" text NOT NULL,
	"dow" smallint NOT NULL,
	"opens" text NOT NULL,
	"closes" text NOT NULL,
	CONSTRAINT "outlet_order_hours_loc_dow_pk" PRIMARY KEY("loc","dow"),
	CONSTRAINT "outlet_order_hours_dow_ck" CHECK ("outlet_order_hours"."dow" between 0 and 6),
	CONSTRAINT "outlet_order_hours_hhmm_ck" CHECK ("outlet_order_hours"."opens" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "outlet_order_hours"."closes" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "outlet_order_hours_window_ck" CHECK ("outlet_order_hours"."closes" > "outlet_order_hours"."opens")
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"qr_order_id" text NOT NULL,
	"bill_no" text,
	"payment_id" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" "refund_reason" NOT NULL,
	"status" "refund_status" DEFAULT 'Pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"rzp_refund_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payment_refunds_amount_ck" CHECK ("payment_refunds"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "qr_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"loc" text NOT NULL,
	"label" text NOT NULL,
	"mode" "qr_mode" NOT NULL,
	"token" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "qr_order_lines" (
	"order_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(12, 2) NOT NULL,
	CONSTRAINT "qr_order_lines_order_id_line_no_pk" PRIMARY KEY("order_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "qr_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"loc" text NOT NULL,
	"qr_code_id" text NOT NULL,
	"label" text NOT NULL,
	"mode" "qr_mode" NOT NULL,
	"spot" text DEFAULT '' NOT NULL,
	"status" "qr_order_status" DEFAULT 'Awaiting payment' NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"tax" numeric(12, 2) NOT NULL,
	"discount" numeric(12, 2) DEFAULT 0 NOT NULL,
	"secret_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"rzp_order_id" text,
	"rzp_payment_id" text,
	"bill_no" text,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qr_outlet_state" (
	"loc" text PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "rzp_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_id_ck";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "source" "bill_source" DEFAULT 'till' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "qr_order_id" text;--> statement-breakpoint
ALTER TABLE "outlet_order_hours" ADD CONSTRAINT "outlet_order_hours_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_qr_order_id_qr_orders_id_fk" FOREIGN KEY ("qr_order_id") REFERENCES "qr_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_bill_no_bills_no_fk" FOREIGN KEY ("bill_no") REFERENCES "bills"("no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_order_lines" ADD CONSTRAINT "qr_order_lines_order_id_qr_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "qr_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_order_lines" ADD CONSTRAINT "qr_order_lines_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_orders" ADD CONSTRAINT "qr_orders_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_orders" ADD CONSTRAINT "qr_orders_qr_code_id_qr_codes_id_fk" FOREIGN KEY ("qr_code_id") REFERENCES "qr_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_orders" ADD CONSTRAINT "qr_orders_bill_no_bills_no_fk" FOREIGN KEY ("bill_no") REFERENCES "bills"("no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_outlet_state" ADD CONSTRAINT "qr_outlet_state_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_outlet_state" ADD CONSTRAINT "qr_outlet_state_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_rzp_refund_uq" ON "payment_refunds" USING btree ("rzp_refund_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_order_idx" ON "payment_refunds" USING btree ("qr_order_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_due_idx" ON "payment_refunds" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_codes_token_uq" ON "qr_codes" USING btree ("token");--> statement-breakpoint
CREATE INDEX "qr_codes_loc_idx" ON "qr_codes" USING btree ("loc");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_orders_nonce_uq" ON "qr_orders" USING btree ("nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_orders_rzp_order_uq" ON "qr_orders" USING btree ("rzp_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_orders_rzp_payment_uq" ON "qr_orders" USING btree ("rzp_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_orders_bill_uq" ON "qr_orders" USING btree ("bill_no");--> statement-breakpoint
CREATE INDEX "qr_orders_loc_status_idx" ON "qr_orders" USING btree ("loc","status");--> statement-breakpoint
CREATE INDEX "qr_orders_phone_status_idx" ON "qr_orders" USING btree ("customer_phone","status");--> statement-breakpoint
CREATE INDEX "qr_orders_ip_created_idx" ON "qr_orders" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "qr_orders_expiry_idx" ON "qr_orders" USING btree ("expires_at") WHERE "qr_orders"."status" = 'Awaiting payment';--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_qr_order_id_qr_orders_id_fk" FOREIGN KEY ("qr_order_id") REFERENCES "qr_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bills_qr_order_uq" ON "bills" USING btree ("qr_order_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_ck" CHECK (("users"."admin" or "users"."system" or "users"."role_id" is not null) and not ("users"."admin" and "users"."system"));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_source_ck" CHECK (("bills"."source" = 'qr') = ("bills"."qr_order_id" is not null));--> statement-breakpoint
-- QR orders came after the seeded roles: the Counter Operator works the queue (edit) and the
-- Outlet Manager watches it (view), as `DESK_DEFAULTS` in @rch/domain now says. Invisible to
-- drizzle-kit, which diffs schema and not data. A role the super admin has already given a level
-- of `qr_orders` keeps it.
UPDATE "roles" SET "perms" = jsonb_set("perms", '{f,qr_orders}', '"edit"'), "updated_at" = now()
WHERE "id" = 'ROLE-001' AND "desk" = 'counter' AND ("perms" -> 'f' -> 'qr_orders') IS NULL;
--> statement-breakpoint
UPDATE "roles" SET "perms" = jsonb_set("perms", '{f,qr_orders}', '"view"'), "updated_at" = now()
WHERE "id" = 'ROLE-002' AND "desk" = 'manager' AND ("perms" -> 'f' -> 'qr_orders') IS NULL;
