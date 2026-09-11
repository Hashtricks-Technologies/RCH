-- When the outlet needs the tray by. Nullable: an order with no date is the ordinary case, and
-- a default of today would put a deadline on every order nobody asked for.
ALTER TABLE "prod_orders" ADD COLUMN "need_by" date;
