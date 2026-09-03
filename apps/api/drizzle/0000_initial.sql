CREATE TYPE "item_type" AS ENUM('RAW', 'PACK', 'MRP', 'FG', 'MTO');--> statement-breakpoint
CREATE TYPE "location_type" AS ENUM('Store', 'Kitchen', 'Outlet');--> statement-breakpoint
CREATE TYPE "message_from" AS ENUM('user', 'support');--> statement-breakpoint
CREATE TYPE "move_kind" AS ENUM('opening', 'sale', 'ticket_out', 'ticket_in', 'production_consume', 'production_yield', 'grn_accept', 'grn_reject', 'adjustment', 'reversal');--> statement-breakpoint
CREATE TYPE "payer_kind" AS ENUM('patient', 'staff', 'dept');--> statement-breakpoint
CREATE TYPE "po_status" AS ENUM('Draft', 'Ordered', 'Partially received', 'Received', 'Cancelled');--> statement-breakpoint
CREATE TYPE "price_list" AS ENUM('A', 'B');--> statement-breakpoint
CREATE TYPE "prod_order_status" AS ENUM('New', 'Accepted', 'In kitchen', 'Ready', 'Dispatched', 'Declined');--> statement-breakpoint
CREATE TYPE "product_req_status" AS ENUM('Requested', 'Created', 'Declined');--> statement-breakpoint
CREATE TYPE "prq_status" AS ENUM('Sent', 'Approved', 'Partially approved', 'Declined');--> statement-breakpoint
CREATE TYPE "req_status" AS ENUM('Draft', 'Request sent', 'Manager approved', 'Partially approved', 'Ticket issued', 'Collected', 'Received', 'Closed', 'Rejected', 'Cancelled');--> statement-breakpoint
CREATE TYPE "role" AS ENUM('counter', 'manager', 'store', 'prod', 'buyer');--> statement-breakpoint
CREATE TYPE "shop_ask_status" AS ENUM('Asked', 'Sent', 'Declined');--> statement-breakpoint
CREATE TYPE "support_priority" AS ENUM('Low', 'Normal', 'Urgent');--> statement-breakpoint
CREATE TYPE "support_status" AS ENUM('Open', 'With support', 'Waiting on you', 'Resolved', 'Closed');--> statement-breakpoint
CREATE TYPE "support_topic" AS ENUM('Sign in & access', 'A screen will not load', 'A number looks wrong', 'Printing & receipts', 'Slow or freezing', 'Training & how do I', 'Feature request', 'Something else');--> statement-breakpoint
CREATE TYPE "ticket_ref" AS ENUM('request', 'prod_order', 'direct', 'shop_transfer', 'shop_ask');--> statement-breakpoint
CREATE TYPE "ticket_status" AS ENUM('Issued', 'Collected', 'Received');--> statement-breakpoint
CREATE TABLE "items" (
	"key" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"type" "item_type" NOT NULL,
	"grp" text NOT NULL,
	"hsn" text NOT NULL,
	"gst" numeric(5, 2) NOT NULL,
	"reorder_level" numeric(12, 3) DEFAULT 0 NOT NULL,
	"cost" numeric(12, 2) DEFAULT 0 NOT NULL,
	"mrp" numeric(12, 2),
	"shelf_life_hours" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_items" (
	"loc" text NOT NULL,
	"item_key" text NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "location_items_loc_item_key_pk" PRIMARY KEY("loc","item_key")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"type" "location_type" NOT NULL,
	"floor" text NOT NULL,
	"cost_centre" text NOT NULL,
	"price_list" "price_list",
	"sellable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"list" "price_list" NOT NULL,
	"item_key" text NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_items_list_item_key_pk" PRIMARY KEY("list","item_key")
);
--> statement-breakpoint
CREATE TABLE "rate_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"item_key" text NOT NULL,
	"rate" numeric(12, 2) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"moq" numeric(12, 3) DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_lines" (
	"item_key" text NOT NULL,
	"ingredient_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "recipe_lines_item_key_ingredient_key_pk" PRIMARY KEY("item_key","ingredient_key")
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"item_key" text PRIMARY KEY NOT NULL,
	"overhead_pct" numeric(5, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "role" NOT NULL,
	"role_label" text NOT NULL,
	"loc" text NOT NULL,
	"colour" text NOT NULL,
	"emp_no" text NOT NULL,
	"phone" text NOT NULL,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"gstin" text DEFAULT '' NOT NULL,
	"contact" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	"lead_days" integer DEFAULT 0 NOT NULL,
	"groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_overrides" (
	"loc" text NOT NULL,
	"item_key" text NOT NULL,
	"reason" text NOT NULL,
	"by_user" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_overrides_loc_item_key_pk" PRIMARY KEY("loc","item_key")
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reservations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"loc" text NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"ticket_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"loc" text NOT NULL,
	"item_key" text NOT NULL,
	"on_hand" numeric(12, 3) DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_loc_item_key_pk" PRIMARY KEY("loc","item_key")
);
--> statement-breakpoint
CREATE TABLE "stock_moves" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_moves_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"loc" text NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"kind" "move_kind" NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"by_user" text,
	"reverses_id" bigint
);
--> statement-breakpoint
CREATE TABLE "shop_asks" (
	"id" text PRIMARY KEY NOT NULL,
	"from_loc" text NOT NULL,
	"to_loc" text NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"status" "shop_ask_status" NOT NULL,
	"by_user" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"granted_qty" numeric(12, 3),
	"ticket_id" text,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_request_lines" (
	"request_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"approved_qty" numeric(12, 3) DEFAULT 0 NOT NULL,
	"short_qty" numeric(12, 3),
	CONSTRAINT "stock_request_lines_request_id_line_no_pk" PRIMARY KEY("request_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "stock_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"from_loc" text NOT NULL,
	"by_user" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "req_status" NOT NULL,
	"ticket_id" text,
	"manager_note" text DEFAULT '' NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_lines" (
	"ticket_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	CONSTRAINT "ticket_lines_ticket_id_line_no_pk" PRIMARY KEY("ticket_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"ref_type" "ticket_ref" NOT NULL,
	"ref_id" text NOT NULL,
	"from_loc" text NOT NULL,
	"to_loc" text NOT NULL,
	"status" "ticket_status" NOT NULL,
	"otp" char(6) NOT NULL,
	"issued_by" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collected_at" timestamp with time zone,
	"received_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" text PRIMARY KEY NOT NULL,
	"item_key" text NOT NULL,
	"started_qty" numeric(12, 3) NOT NULL,
	"made_qty" numeric(12, 3) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"best_before" timestamp with time zone NOT NULL,
	"note" text,
	"by_user" text
);
--> statement-breakpoint
CREATE TABLE "prod_order_lines" (
	"order_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	CONSTRAINT "prod_order_lines_order_id_line_no_pk" PRIMARY KEY("order_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "prod_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"from_loc" text NOT NULL,
	"by_user" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "prod_order_status" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grns" (
	"id" text PRIMARY KEY NOT NULL,
	"po_id" text NOT NULL,
	"po_line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"accepted_qty" numeric(12, 3) NOT NULL,
	"rejected_qty" numeric(12, 3) DEFAULT 0 NOT NULL,
	"batch_no" text NOT NULL,
	"mrp" numeric(12, 2) DEFAULT 0 NOT NULL,
	"mfg" date NOT NULL,
	"exp" date NOT NULL,
	"dc_no" text NOT NULL,
	"invoice_no" text DEFAULT '' NOT NULL,
	"invoice_date" date,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"by_user" text
);
--> statement-breakpoint
CREATE TABLE "po_line_sources" (
	"po_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"seq" integer NOT NULL,
	"requisition_id" text NOT NULL,
	"requisition_line_no" integer NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	CONSTRAINT "po_line_sources_po_id_line_no_seq_pk" PRIMARY KEY("po_id","line_no","seq")
);
--> statement-breakpoint
CREATE TABLE "po_lines" (
	"po_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(12, 2) NOT NULL,
	"received_qty" numeric(12, 3) DEFAULT 0 NOT NULL,
	"rejected_qty" numeric(12, 3) DEFAULT 0 NOT NULL,
	CONSTRAINT "po_lines_po_id_line_no_pk" PRIMARY KEY("po_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "po_status" NOT NULL,
	"eta" date,
	"needs_approval" boolean DEFAULT false NOT NULL,
	"short_note" text,
	"received_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requisition_lines" (
	"requisition_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"approved_qty" numeric(12, 3) DEFAULT 0 NOT NULL,
	"ordered_qty" numeric(12, 3) DEFAULT 0 NOT NULL,
	"short_qty" numeric(12, 3),
	CONSTRAINT "requisition_lines_requisition_id_line_no_pk" PRIMARY KEY("requisition_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "requisitions" (
	"id" text PRIMARY KEY NOT NULL,
	"by_user" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "prq_status" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"approved_by" text,
	"approval_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_lines" (
	"bill_no" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(12, 2) NOT NULL,
	CONSTRAINT "bill_lines_bill_no_line_no_pk" PRIMARY KEY("bill_no","line_no")
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"no" text PRIMARY KEY NOT NULL,
	"loc" text NOT NULL,
	"operator_id" text NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"tax" numeric(12, 2) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"tender" text NOT NULL,
	"payer_kind" "payer_kind",
	"payer_id" text,
	"payer_name" text
);
--> statement-breakpoint
CREATE TABLE "product_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"for_loc" text NOT NULL,
	"by_user" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "product_req_status" NOT NULL,
	"note" text,
	"item_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"from" "message_from" NOT NULL,
	"who" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" "support_topic" NOT NULL,
	"subject" text NOT NULL,
	"priority" "support_priority" NOT NULL,
	"status" "support_status" NOT NULL,
	"by_user" text NOT NULL,
	"role" "role" NOT NULL,
	"loc" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"screen" text DEFAULT '' NOT NULL,
	"rating" smallint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "document_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_type" text NOT NULL,
	"doc_id" text NOT NULL,
	"status" text NOT NULL,
	"who" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text NOT NULL,
	"user_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_key_user_id_pk" PRIMARY KEY("key","user_id")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"family" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"kind" text PRIMARY KEY NOT NULL,
	"next" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "location_items" ADD CONSTRAINT "location_items_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_items" ADD CONSTRAINT "location_items_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_contracts" ADD CONSTRAINT "rate_contracts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_contracts" ADD CONSTRAINT "rate_contracts_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_item_key_recipes_item_key_fk" FOREIGN KEY ("item_key") REFERENCES "recipes"("item_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_ingredient_key_items_key_fk" FOREIGN KEY ("ingredient_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_overrides" ADD CONSTRAINT "availability_overrides_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_overrides" ADD CONSTRAINT "availability_overrides_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_overrides" ADD CONSTRAINT "availability_overrides_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_asks" ADD CONSTRAINT "shop_asks_from_loc_locations_key_fk" FOREIGN KEY ("from_loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_asks" ADD CONSTRAINT "shop_asks_to_loc_locations_key_fk" FOREIGN KEY ("to_loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_asks" ADD CONSTRAINT "shop_asks_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_asks" ADD CONSTRAINT "shop_asks_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_asks" ADD CONSTRAINT "shop_asks_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_request_lines" ADD CONSTRAINT "stock_request_lines_request_id_stock_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "stock_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_request_lines" ADD CONSTRAINT "stock_request_lines_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_from_loc_locations_key_fk" FOREIGN KEY ("from_loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_from_loc_locations_key_fk" FOREIGN KEY ("from_loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_to_loc_locations_key_fk" FOREIGN KEY ("to_loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prod_order_lines" ADD CONSTRAINT "prod_order_lines_order_id_prod_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "prod_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prod_order_lines" ADD CONSTRAINT "prod_order_lines_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prod_orders" ADD CONSTRAINT "prod_orders_from_loc_locations_key_fk" FOREIGN KEY ("from_loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prod_orders" ADD CONSTRAINT "prod_orders_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grns" ADD CONSTRAINT "grns_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grns" ADD CONSTRAINT "grns_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grns" ADD CONSTRAINT "grns_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_line_sources" ADD CONSTRAINT "po_line_sources_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_line_sources" ADD CONSTRAINT "po_line_sources_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_no_bills_no_fk" FOREIGN KEY ("bill_no") REFERENCES "bills"("no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_operator_id_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_for_loc_locations_key_fk" FOREIGN KEY ("for_loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "items_name_ci_uq" ON "items" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_emp_no_uq" ON "users" USING btree ("emp_no");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_name_ci_uq" ON "vendors" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "reservations_open_idx" ON "reservations" USING btree ("loc","item_key") WHERE released_at is null;--> statement-breakpoint
CREATE INDEX "stock_moves_loc_item_at_idx" ON "stock_moves" USING btree ("loc","item_key","at");--> statement-breakpoint
CREATE INDEX "stock_moves_ref_idx" ON "stock_moves" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "stock_requests_status_idx" ON "stock_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "stock_requests_from_idx" ON "stock_requests" USING btree ("from_loc");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tickets_to_idx" ON "tickets" USING btree ("to_loc");--> statement-breakpoint
CREATE INDEX "grns_po_idx" ON "grns" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bills_loc_at_idx" ON "bills" USING btree ("loc","at");--> statement-breakpoint
CREATE INDEX "document_history_doc_idx" ON "document_history" USING btree ("doc_type","doc_id","at");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");