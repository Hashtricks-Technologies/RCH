CREATE TABLE "payers" (
	"kind" "payer_kind" NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "payers_kind_id_pk" PRIMARY KEY("kind","id")
);
