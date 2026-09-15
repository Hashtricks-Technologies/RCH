-- The audit service's own storage. Unqualified on purpose, like every API migration: the migrate
-- CLI and the test harness run it with search_path = AUDIT_SCHEMA, so production lands in `audit`
-- and each test file in its own `t_audit_<name>_<pid>_a`. Nothing here references the API's tables.
CREATE TABLE "dead_letters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dead_letters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"outbox_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"event" jsonb NOT NULL,
	"issue" text NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"outbox_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"request_id" text NOT NULL,
	"actor_id" text,
	"actor_emp" text NOT NULL,
	"actor_name" text NOT NULL,
	"actor_role" text NOT NULL,
	"actor_loc" text NOT NULL,
	"action" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"target_loc" text DEFAULT '' NOT NULL,
	"outcome" text NOT NULL,
	"status" smallint NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"cause" text,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"before" jsonb,
	"result" jsonb,
	"changed" text[] DEFAULT '{}'::text[] NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_outbox_id_uq" UNIQUE("outbox_id"),
	CONSTRAINT "events_outcome_ck" CHECK ("outcome" in ('done', 'refused', 'error'))
);
--> statement-breakpoint
CREATE INDEX "events_at_idx" ON "events" USING btree ("at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("actor_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_target_idx" ON "events" USING btree ("target","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_action_idx" ON "events" USING btree ("action","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_outcome_idx" ON "events" USING btree ("outcome","id" DESC NULLS LAST);--> statement-breakpoint

-- Retention is forever and a log that can be edited is not a log. The API's ledger triggers (its
-- 0002 and 0008) refuse UPDATE and DELETE row by row; these are statement-level so they also refuse
-- TRUNCATE, and refuse an UPDATE or DELETE that matches no row, for every role including the owner.
-- Invisible to drizzle-kit, like the API's triggers: that is not drift.
CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% is append-only; the audit log is never edited', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "events" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
--> statement-breakpoint
CREATE TRIGGER dead_letters_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "dead_letters" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
