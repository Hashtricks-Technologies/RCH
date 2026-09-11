ALTER TABLE "payers" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
