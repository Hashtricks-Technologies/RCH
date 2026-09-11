-- A write-off or a count-up, as a document.
--
-- `move_kind` has carried 'adjustment' since 0000 with nothing writing it: wastage, breakage, an
-- expiry disposal, a physical-count correction and a return out of the rejected-goods shelf were
-- all hand-written SQL, with no signature and no reason. These two tables are the document
-- behind those moves, so a shelf that changed says who changed it and why.
--
-- The reason is a type rather than free text: it is what a month-end query groups by, and
-- "spoilt", "spoiled" and "Spoilt" would be three answers to one question.
CREATE TYPE "adjust_reason" AS ENUM('wastage', 'breakage', 'expired', 'count', 'returned_to_vendor', 'other');--> statement-breakpoint
CREATE TABLE "adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"loc" text NOT NULL,
	"reason" "adjust_reason" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"by_user" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Signed, like the moves behind them: negative wrote stock off, positive counted it up. One line
-- per item — the service folds a repeated item and drops what folds to zero before writing — so
-- a line here is exactly one `adjustment` move on the ledger.
CREATE TABLE "adjustment_lines" (
	"adjustment_id" text NOT NULL,
	"line_no" smallint NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	CONSTRAINT "adjustment_lines_adjustment_id_line_no_pk" PRIMARY KEY("adjustment_id","line_no")
);--> statement-breakpoint
-- `locations` and not a narrower list on purpose: the rejected-goods shelf is a location, and it
-- is the one shelf nothing else in the system can ever take stock off again.
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_lines" ADD CONSTRAINT "adjustment_lines_adjustment_id_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_lines" ADD CONSTRAINT "adjustment_lines_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Both readers ask the same question: one shelf over a window.
CREATE INDEX "adjustments_loc_at_idx" ON "adjustments" USING btree ("loc","at");--> statement-breakpoint
-- The series starts at one: nothing was ever written off through a document before, so there is
-- no seeded run to continue. `ensureSequences` (apps/api/src/lib/ids.ts) inserts the same row
-- from SEQUENCE_START on a fresh seed; this is for a database that is already migrated.
INSERT INTO "sequences" ("kind","next") VALUES ('adj', 1) ON CONFLICT DO NOTHING;
