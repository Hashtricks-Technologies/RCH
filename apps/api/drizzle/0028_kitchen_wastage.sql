CREATE TABLE "wastage" (
	"id" text PRIMARY KEY NOT NULL,
	"item_key" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"reason" "adjust_reason" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"cost" numeric(12, 2) NOT NULL,
	"value" numeric(12, 2) NOT NULL,
	"by_user" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wastage_qty_ck" CHECK ("wastage"."qty" > 0),
	CONSTRAINT "wastage_reason_ck" CHECK ("wastage"."reason" in ('wastage', 'breakage', 'expired', 'other'))
);
--> statement-breakpoint
ALTER TABLE "wastage" ADD CONSTRAINT "wastage_item_key_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "items"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage" ADD CONSTRAINT "wastage_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wastage_at_idx" ON "wastage" USING btree ("at");--> statement-breakpoint
-- The kitchen's raw materials and packaging stop being stocked there: from now on whatever lands
-- is used on landing (`usedOnArrival`, @rch/domain), and a loss is a `wastage` row above. What the
-- kitchen was holding at deploy is cleared the same way - as used - through the ledger's own
-- shape: one `production_consume` move per line, appended (stock_moves is append-only), and the
-- balance cache moved by exactly that move, which is what `postMoves` would have written. Only a
-- positive balance is cleared; a line already at zero has nothing to use. Run once, like every
-- migration; a second pass would find every such balance at zero and insert nothing.
INSERT INTO "stock_moves" ("loc", "item_key", "qty", "kind", "ref_type", "ref_id")
SELECT b."loc", b."item_key", -b."on_hand", 'production_consume', 'migration', '0028_kitchen_wastage'
FROM "stock_balances" b JOIN "items" i ON i."key" = b."item_key"
WHERE b."loc" = 'kitchen' AND i."type" IN ('RAW', 'PACK') AND b."on_hand" > 0;--> statement-breakpoint
UPDATE "stock_balances" b SET "on_hand" = 0, "updated_at" = now()
FROM "items" i
WHERE i."key" = b."item_key" AND b."loc" = 'kitchen' AND i."type" IN ('RAW', 'PACK') AND b."on_hand" > 0;
