CREATE TABLE "earnings_calendar" (
	"fetched_on" date NOT NULL,
	"symbol" text NOT NULL,
	"report_date" date NOT NULL,
	"fiscal_date_ending" date,
	"estimate" numeric,
	"currency" text,
	"time_of_day" text,
	CONSTRAINT "earnings_calendar_fetched_on_symbol_report_date_pk" PRIMARY KEY("fetched_on","symbol","report_date")
);
--> statement-breakpoint
CREATE INDEX "earnings_calendar_symbol_idx" ON "earnings_calendar" USING btree ("symbol","report_date");