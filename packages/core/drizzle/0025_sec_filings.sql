CREATE TABLE "sec_filings" (
	"accession" text NOT NULL,
	"symbol" text NOT NULL,
	"cik" text NOT NULL,
	"form" text NOT NULL,
	"filed_on" date NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"items" text NOT NULL,
	"url" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"sell_signal" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sec_filings_accession_symbol_pk" PRIMARY KEY("accession","symbol")
);
--> statement-breakpoint
CREATE INDEX "sec_filings_symbol_idx" ON "sec_filings" USING btree ("symbol","filed_on");