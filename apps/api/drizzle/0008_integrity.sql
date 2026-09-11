-- Integrity the application already promises, written where nothing can talk past it.
--
-- Every constraint below restates a rule a service already enforces; the point is that a bug,
-- a hand-run UPDATE at 2am or a future module that forgets the rule cannot leave a row behind
-- that the books can never balance again.
--
-- One rule is deliberately NOT here: `stock_balances.on_hand >= 0`. The friendly refusal an
-- operator reads ("Only 2 nos of Mineral water 1L left at Coffee Shop") comes from the re-read
-- that runs AFTER postMoves has already driven the balance down, under the locks it holds — so
-- a CHECK would fire first and turn every one of those sentences into a 500 with no words in it.
-- The negative balance never survives: the same transaction rolls it back. Leave it out.

--> statement-breakpoint
-- Every handover and every cancellation updates the open holds of one ticket, and nothing
-- indexed ticket_id: a release was a sequential scan over every hold ever placed.
CREATE INDEX "reservations_ticket_idx" ON "reservations" ("ticket_id") WHERE "released_at" IS NULL;
--> statement-breakpoint
-- The reference the Drizzle schema cannot declare: `reservations` lives in schema/ledger.ts and
-- `tickets` in schema/movement.ts, and importing one into the other closes an import cycle. The
-- database can say it even where the TypeScript cannot, so it does — see the comment on
-- `reservations.ticketId`.
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_ticket_fk" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id");
--> statement-breakpoint

-- A ticket's six digits, and how many times somebody has guessed at them.
ALTER TABLE "tickets" ADD COLUMN "otp_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- char(6) pads and compares blank-padded, which is the wrong shape for a secret: varchar(6)
-- with the digits spelled out is what the column has always actually held.
ALTER TABLE "tickets" ALTER COLUMN "otp" TYPE varchar(6);
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_otp_digits_ck" CHECK ("otp" ~ '^[0-9]{6}$');
--> statement-breakpoint
-- A ticket from a location to itself moves nothing and can never be received.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_from_to_ck" CHECK ("from_loc" <> "to_loc");
--> statement-breakpoint

-- A move of zero is not a movement. It reads as "this location carries the line" on every stock
-- screen (M12) without ever having carried anything, and no caller means one.
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_qty_ck" CHECK ("qty" <> 0);
--> statement-breakpoint
-- A hold for nothing is not a hold.
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_qty_ck" CHECK ("qty" > 0);
--> statement-breakpoint
-- The kitchen cannot yield more than it started, and cannot yield a negative number of units.
ALTER TABLE "batches" ADD CONSTRAINT "batches_made_ck" CHECK ("made_qty" >= 0 AND "made_qty" <= "started_qty");
--> statement-breakpoint
-- `received_qty` is the gross that arrived and `rejected_qty` the part of it turned away, so
-- the second can never be larger than the first.
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_receipt_ck" CHECK ("rejected_qty" >= 0 AND "rejected_qty" <= "received_qty" AND "received_qty" >= 0);
--> statement-breakpoint
-- A purchase order can only claim what the buyer approved (lib/claims.ts keeps it there).
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_ordered_ck" CHECK ("ordered_qty" >= 0 AND "ordered_qty" <= "approved_qty");
--> statement-breakpoint
-- Five stars or none.
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_rating_ck" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);
--> statement-breakpoint
-- A series that has run backwards to zero would re-issue a number already printed.
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_next_ck" CHECK ("next" > 0);
--> statement-breakpoint

-- The audit trail, protected the way the ledger already is (0002): a row that can be edited
-- afterwards is not a trail. Append a correcting row instead.
CREATE OR REPLACE FUNCTION document_history_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'document_history is append-only; append a correcting entry';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER document_history_no_update_delete BEFORE UPDATE OR DELETE ON document_history FOR EACH ROW EXECUTE FUNCTION document_history_append_only();
