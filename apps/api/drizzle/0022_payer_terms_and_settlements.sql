-- What each party is charged, and what brings down what they owe.
--
-- Three new tables and two new columns on `bills`. The columns default to zero, so every bill
-- taken before this existed reads as the undiscounted bill it was - nothing is backfilled and no
-- figure already reconciled moves. `bills.total` keeps its meaning throughout: what the bill is
-- worth and what is owed. The gross is `total + discount`, derived, never stored.

CREATE TABLE "payer_class_terms" (
	"cls" text PRIMARY KEY NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"credit_limit" numeric(12, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "payer_terms" (
	"kind" "payer_kind" NOT NULL,
	"payer_id" text NOT NULL,
	"discount_pct" numeric(5, 2),
	"credit_limit" numeric(12, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "payer_terms_kind_payer_id_pk" PRIMARY KEY("kind","payer_id")
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "payer_kind" NOT NULL,
	"payer_id" text NOT NULL,
	"payer_name" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"mode" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"by" text NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "settlement_lines" (
	"settlement_id" text NOT NULL,
	"bill_no" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	CONSTRAINT "settlement_lines_settlement_id_bill_no_pk" PRIMARY KEY("settlement_id","bill_no")
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "discount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payer_class_terms" ADD CONSTRAINT "payer_class_terms_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_terms" ADD CONSTRAINT "payer_terms_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_terms" ADD CONSTRAINT "payer_terms_payer_fk" FOREIGN KEY ("kind","payer_id") REFERENCES "payers"("kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_by_users_id_fk" FOREIGN KEY ("by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payer_fk" FOREIGN KEY ("kind","payer_id") REFERENCES "payers"("kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_bill_no_bills_no_fk" FOREIGN KEY ("bill_no") REFERENCES "bills"("no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settlements_payer_idx" ON "settlements" USING btree ("kind","payer_id","at");--> statement-breakpoint
CREATE INDEX "settlement_lines_bill_idx" ON "settlement_lines" USING btree ("bill_no");--> statement-breakpoint
-- The old index was partial on `payer_kind = 'staff'`, which was right while staff credit was the
-- only balance anybody could run up. Every credit sale now sums what its own payer owes, and the
-- manager's receivables list does it for everybody at once.
DROP INDEX IF EXISTS "bills_staff_credit_idx";--> statement-breakpoint
CREATE INDEX "bills_payer_idx" ON "bills" USING btree ("payer_kind","payer_id","at") WHERE payer_kind is not null and voided_at is null;--> statement-breakpoint
-- The rate card opens with every category on it, so the till always finds a row to price
-- against. Customers and patients pay the shelf price; only staff carries a ceiling, because
-- that is the one this system has always enforced. `null` is no ceiling, not a ceiling of zero.
INSERT INTO "payer_class_terms" ("cls", "discount_pct", "credit_limit") VALUES
	('customer', 0, NULL),
	('patient', 0, NULL),
	('staff', 0, 3000),
	('doctor', 0, NULL),
	('dept', 0, NULL)
ON CONFLICT ("cls") DO NOTHING;
