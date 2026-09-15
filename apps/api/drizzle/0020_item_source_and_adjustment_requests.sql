CREATE TYPE "adj_req_status" AS ENUM('Request sent', 'Approved', 'Rejected', 'Cancelled');--> statement-breakpoint
CREATE TYPE "source" AS ENUM('store', 'kitchen');--> statement-breakpoint
CREATE TABLE "adjustment_request_lines" (
	"request_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	CONSTRAINT "adjustment_request_lines_request_id_line_no_pk" PRIMARY KEY("request_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "adjustment_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"loc" text NOT NULL,
	"reason" "adjust_reason" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"by_user" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "adj_req_status" NOT NULL,
	"approved_by" text,
	"adjustment_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "src" "source";--> statement-breakpoint
ALTER TABLE "adjustment_request_lines" ADD CONSTRAINT "adjustment_request_lines_request_id_adjustment_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "adjustment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_request_lines" ADD CONSTRAINT "adjustment_request_lines_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_requests" ADD CONSTRAINT "adjustment_requests_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_requests" ADD CONSTRAINT "adjustment_requests_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_requests" ADD CONSTRAINT "adjustment_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_requests" ADD CONSTRAINT "adjustment_requests_adjustment_id_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adjustment_requests_status_idx" ON "adjustment_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "adjustment_requests_loc_idx" ON "adjustment_requests" USING btree ("loc");