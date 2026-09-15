-- Price lists become a named entity instead of the closed pair "A"/"B": a manager may create as
-- many as they want, each with its own id and name, and switch which one an outlet is active on.
-- The two existing lists carry over exactly as "PL-001"/"PL-002" ("List A"/"List B"), the same
-- ids `formatId("price_list", 1 | 2)` would produce, so `SEQUENCE_START.price_list = 3`
-- continues past them - the same way seeded vendors sit ahead of `SEQUENCE_START.vendor`.
CREATE TABLE "price_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Only when there is old "A"/"B" data to preserve - a live hospital already mid-operation. A
-- freshly migrated, still-empty database (every CI run, a fresh local `db:migrate`) inserts
-- nothing here and gets its two starting lists from `db:seed` instead, which would otherwise
-- collide with these same ids.
INSERT INTO "price_lists" ("id", "name")
SELECT * FROM (VALUES ('PL-001', 'List A'), ('PL-002', 'List B')) AS v("id", "name")
WHERE EXISTS (SELECT 1 FROM "locations" WHERE "price_list" IS NOT NULL)
   OR EXISTS (SELECT 1 FROM "price_list_items");--> statement-breakpoint
-- "price_list_items": "list" (the enum) becomes "list_id" (a real foreign key). Added nullable,
-- backfilled from the old column, then tightened - a row written before this migration keeps
-- exactly the list it was on.
ALTER TABLE "price_list_items" ADD COLUMN "list_id" text;--> statement-breakpoint
UPDATE "price_list_items" SET "list_id" = CASE "list" WHEN 'A' THEN 'PL-001' WHEN 'B' THEN 'PL-002' END;--> statement-breakpoint
ALTER TABLE "price_list_items" ALTER COLUMN "list_id" SET NOT NULL;--> statement-breakpoint
-- Cascading: once a price list is unattached from every outlet (the only way it may be
-- deleted, `pricelistsRepo.remove`), its own price sheet goes with it.
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_list_id_price_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" DROP CONSTRAINT "price_list_items_list_item_key_pk";--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_list_id_item_key_pk" PRIMARY KEY("list_id","item_key");--> statement-breakpoint
ALTER TABLE "price_list_items" DROP COLUMN "list";--> statement-breakpoint
-- "locations": "price_list" (the enum, nullable) becomes "price_list_id" (nullable still - the
-- store and the kitchen carry none - but `ON DELETE RESTRICT`: a list still active at an outlet
-- cannot be deleted out from under it).
ALTER TABLE "locations" ADD COLUMN "price_list_id" text;--> statement-breakpoint
UPDATE "locations" SET "price_list_id" = CASE "price_list" WHEN 'A' THEN 'PL-001' WHEN 'B' THEN 'PL-002' ELSE NULL END;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" DROP COLUMN "price_list";--> statement-breakpoint
DROP TYPE "price_list";
