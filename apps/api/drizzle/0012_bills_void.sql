-- A same-day void for a mis-keyed bill.
--
-- Three nullable columns rather than a status word or a second document: the bill stays exactly
-- as it was printed — number, lines, total, tax, payer — and what changes is that reversing
-- moves put the stock back and every sum that counts money learns to skip it. `voided_at` is the
-- flag all of those read (`voided_at is null`): the staff-credit ceiling, so a void frees that
-- person's room for the month, and the dashboard's sales columns, so a voided bill is not takings.
--
-- No index of its own. A void is rare and the two filters that read the column are already
-- narrowed by something else first — `bills_staff_credit_idx` for the ceiling, `bills_loc_at_idx`
-- for the day's columns — so a partial index here would be a second structure to maintain for
-- rows a hospital sees a handful of in a month.
ALTER TABLE "bills" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "void_reason" text;--> statement-breakpoint
-- Who took it back is a real person on the roster, and stays answerable for it.
ALTER TABLE "bills" ADD CONSTRAINT "bills_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
