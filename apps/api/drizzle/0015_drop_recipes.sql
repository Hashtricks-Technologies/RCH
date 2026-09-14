-- Recipes are gone from the application. A batch now books only what the kitchen made, and a
-- made-to-order item is sold without moving any stock, so nothing reads these tables any more.
-- Moves already posted against a recipe stay on the ledger untouched: `stock_moves` never
-- referenced either table. The lines go first because they reference their recipe.
DROP TABLE "recipe_lines" CASCADE;--> statement-breakpoint
DROP TABLE "recipes" CASCADE;
