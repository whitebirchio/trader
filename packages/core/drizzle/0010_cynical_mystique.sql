CREATE TABLE "benchmark_closes" (
	"symbol" text NOT NULL,
	"trading_date" date NOT NULL,
	"close" numeric NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benchmark_closes_symbol_trading_date_pk" PRIMARY KEY("symbol","trading_date")
);
