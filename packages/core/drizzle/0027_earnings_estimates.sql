CREATE TABLE "earnings_estimates" (
	"symbol" text NOT NULL,
	"fetched_on" date NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"quarter" jsonb,
	"fiscal_year" jsonb,
	"error" text,
	CONSTRAINT "earnings_estimates_symbol_fetched_on_pk" PRIMARY KEY("symbol","fetched_on")
);
