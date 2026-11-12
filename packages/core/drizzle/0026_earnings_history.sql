CREATE TABLE "earnings_history" (
	"symbol" text NOT NULL,
	"fiscal_date_ending" date NOT NULL,
	"reported_date" date NOT NULL,
	"report_time" text,
	"reported_eps" numeric,
	"estimated_eps" numeric,
	"surprise" numeric,
	"surprise_pct" numeric,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "earnings_history_symbol_fiscal_date_ending_pk" PRIMARY KEY("symbol","fiscal_date_ending")
);
--> statement-breakpoint
CREATE TABLE "earnings_history_fetches" (
	"symbol" text PRIMARY KEY NOT NULL,
	"fetched_on" date NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"quarters" integer NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "earnings_history_reported_idx" ON "earnings_history" USING btree ("reported_date");