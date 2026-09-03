CREATE OR REPLACE FUNCTION stock_moves_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'stock_moves is append-only; correct with a reversing move';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER stock_moves_no_update_delete BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION stock_moves_append_only();
