CREATE TABLE "audit_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" jsonb NOT NULL
);
--> statement-breakpoint
-- Hand-written below: drizzle-kit cannot see a trigger. The API only inserts and the audit service
-- only locks and deletes (it holds `update (at)` solely so `for update skip locked` can take a row
-- lock, and a row lock fires no trigger), so nobody ever has a reason to rewrite an event in place.
CREATE OR REPLACE FUNCTION audit_outbox_no_update() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_outbox rows are never updated; the audit service moves each one as it was written';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_outbox_no_update BEFORE UPDATE ON audit_outbox FOR EACH ROW EXECUTE FUNCTION audit_outbox_no_update();
