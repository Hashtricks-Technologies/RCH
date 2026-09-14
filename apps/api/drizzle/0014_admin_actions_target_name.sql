ALTER TABLE "admin_actions" DROP CONSTRAINT "admin_actions_target_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_actions" ALTER COLUMN "target_id" DROP NOT NULL;--> statement-breakpoint
-- Added nullable, filled from the account each existing line is about, then tightened: a line
-- written before this migration still has its target on `users`, so the name is always there.
ALTER TABLE "admin_actions" ADD COLUMN "target_name" text;--> statement-breakpoint
UPDATE "admin_actions" SET "target_name" = "users"."name" FROM "users" WHERE "users"."id" = "admin_actions"."target_id";--> statement-breakpoint
ALTER TABLE "admin_actions" ALTER COLUMN "target_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
