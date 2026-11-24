ALTER TABLE "roles" ADD COLUMN "inventory_perms" jsonb;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "desk" "role";--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_inventory_perms_ck" CHECK ("roles"."inventory_perms" is null or "roles"."desk" = 'counter');