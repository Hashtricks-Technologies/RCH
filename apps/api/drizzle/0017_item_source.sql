CREATE TYPE "source" AS ENUM('store', 'kitchen');--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "src" "source";