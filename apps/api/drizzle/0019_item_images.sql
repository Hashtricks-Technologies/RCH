ALTER TABLE "items" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_image_sha256_ck" CHECK ("items"."image" is null or "items"."image" ~ '^[0-9a-f]{64}$');