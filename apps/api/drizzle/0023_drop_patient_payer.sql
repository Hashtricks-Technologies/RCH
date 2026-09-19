-- The hospital's F&B counters keep no patient roster, so `patient` is not a kind of payer any
-- more: there is no account to post a bill to and nobody to chase it. The category leaves the
-- till's tenders, the rate card, the payer register and this type.
--
-- Postgres has no `alter type ... drop value`, so the type is rebuilt from scratch and every
-- column carrying it is swapped over. That only works once no row anywhere still says
-- `patient`, which is what the three deletes and the guard below are for.

-- The rate card first: a category nobody can be filed under has no row to price, and a person's
-- exception is meaningless without the payer it hangs off (the FK below would refuse the delete
-- of the payer otherwise).
DELETE FROM "payer_terms" WHERE "kind" = 'patient';--> statement-breakpoint
DELETE FROM "payer_class_terms" WHERE "cls" = 'patient';--> statement-breakpoint
-- Then the register itself, but only where nothing points at it. A payer with a bill against
-- them is somebody's balance and is never deleted - that is the invariant this migration is not
-- allowed to break, which is why the guard below refuses rather than the delete cascading.
DELETE FROM "payers" p WHERE p."kind" = 'patient'
  AND NOT EXISTS (SELECT 1 FROM "bills" b WHERE b."payer_kind" = p."kind" AND b."payer_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "settlements" s WHERE s."kind" = p."kind" AND s."payer_id" = p."id");--> statement-breakpoint
-- And refuse the whole migration if a real patient balance is still on the books. Deleting a
-- bill is not something a schema change may do, and silently re-filing it under another payer
-- would move somebody's money. The operator settles or voids them first (deploy/RUNBOOK.md §17).
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "bills" WHERE "payer_kind" = 'patient' OR "tender" = 'Patient bill')
       + (SELECT count(*) FROM "settlements" WHERE "kind" = 'patient')
       + (SELECT count(*) FROM "payers" WHERE "kind" = 'patient')
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Refused - % patient bill(s), settlement(s) or payer(s) are still on the books; settle or void them before removing the patient category (deploy/RUNBOOK.md 17)', n;
  END IF;
END $$;--> statement-breakpoint
-- The two composite foreign keys into `payers` come off first and go back on at the end. A
-- column's type cannot be changed one table at a time while a key joins it to another that is
-- still the old type: Postgres rebuilds the key as part of the ALTER and refuses it as
-- "text and payer_kind".
ALTER TABLE "payer_terms" DROP CONSTRAINT "payer_terms_payer_fk";--> statement-breakpoint
ALTER TABLE "settlements" DROP CONSTRAINT "settlements_payer_fk";--> statement-breakpoint
ALTER TABLE "payer_terms" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "payers" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "bills" ALTER COLUMN "payer_kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "settlements" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "payer_kind";--> statement-breakpoint
CREATE TYPE "payer_kind" AS ENUM('staff', 'dept', 'doctor');--> statement-breakpoint
ALTER TABLE "payer_terms" ALTER COLUMN "kind" SET DATA TYPE "payer_kind" USING "kind"::"payer_kind";--> statement-breakpoint
ALTER TABLE "payers" ALTER COLUMN "kind" SET DATA TYPE "payer_kind" USING "kind"::"payer_kind";--> statement-breakpoint
ALTER TABLE "bills" ALTER COLUMN "payer_kind" SET DATA TYPE "payer_kind" USING "payer_kind"::"payer_kind";--> statement-breakpoint
ALTER TABLE "settlements" ALTER COLUMN "kind" SET DATA TYPE "payer_kind" USING "kind"::"payer_kind";--> statement-breakpoint
ALTER TABLE "payer_terms" ADD CONSTRAINT "payer_terms_payer_fk" FOREIGN KEY ("kind","payer_id") REFERENCES "payers"("kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payer_fk" FOREIGN KEY ("kind","payer_id") REFERENCES "payers"("kind","id") ON DELETE no action ON UPDATE no action;
