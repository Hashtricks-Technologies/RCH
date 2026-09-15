ALTER TABLE "locations" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "par_factor" numeric(4, 2) DEFAULT 0.18 NOT NULL;--> statement-breakpoint
-- Today's par factors, so no par level moves: store, kitchen and the three outlets carried these in
-- `PAR_FACTOR` (@rch/domain), and the rejected-goods shelf never had one, which read as a full day.
-- An outlet opened after this migration takes the column default.
UPDATE "locations" SET "par_factor" = CASE "key" WHEN 'store' THEN 1 WHEN 'kitchen' THEN 0.35 WHEN 'rest' THEN 0.22 WHEN 'coffee' THEN 0.18 WHEN 'kiosk' THEN 0.15 WHEN 'quarantine' THEN 1 ELSE "par_factor" END;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_name_uq" ON "locations" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "locations_code_uq" ON "locations" USING btree (upper("code"));
