CREATE TABLE "rate_contract_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"old_rate" numeric(12, 2) NOT NULL,
	"new_rate" numeric(12, 2) NOT NULL,
	"po_id" text,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"loc" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_totals" jsonb
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "rate_contract_changes" ADD CONSTRAINT "rate_contract_changes_contract_id_rate_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "rate_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_contract_changes" ADD CONSTRAINT "rate_contract_changes_by_users_id_fk" FOREIGN KEY ("by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_contract_changes_contract_idx" ON "rate_contract_changes" USING btree ("contract_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_open_per_user" ON "shifts" USING btree ("user_id") WHERE "shifts"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "shifts_loc_opened_idx" ON "shifts" USING btree ("loc","opened_at");