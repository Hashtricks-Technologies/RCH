CREATE TABLE "user_postings" (
	"user_id" text NOT NULL,
	"loc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_postings_user_id_loc_pk" PRIMARY KEY("user_id","loc")
);
--> statement-breakpoint
CREATE TABLE "register_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"loc" text NOT NULL,
	"z_no" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"closed_totals" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "loc" text;--> statement-breakpoint
ALTER TABLE "user_postings" ADD CONSTRAINT "user_postings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_postings" ADD CONSTRAINT "user_postings_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_sessions" ADD CONSTRAINT "register_sessions_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_sessions" ADD CONSTRAINT "register_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_sessions" ADD CONSTRAINT "register_sessions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_postings_user_idx" ON "user_postings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "register_sessions_one_open_per_loc" ON "register_sessions" USING btree ("loc") WHERE "register_sessions"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "register_sessions_z_no_uq" ON "register_sessions" USING btree ("z_no");--> statement-breakpoint
CREATE INDEX "register_sessions_loc_closed_idx" ON "register_sessions" USING btree ("loc","closed_at");--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_session_id_register_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "register_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_loc_locations_key_fk" FOREIGN KEY ("loc") REFERENCES "locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Every account keeps the posting it already had. Invisible to drizzle-kit, which diffs schema
-- and not data, so it is written by hand here: without it every existing account would sign in
-- with no postings at all and the picker would have nothing to offer.
INSERT INTO "user_postings" ("user_id", "loc")
SELECT "id", "loc" FROM "users"
ON CONFLICT DO NOTHING;
