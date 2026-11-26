CREATE TABLE "position_snapshots" (
	"trading_date" date NOT NULL,
	"symbol" text NOT NULL,
	"qty" numeric NOT NULL,
	"close" numeric,
	"market_value" numeric,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_snapshots_trading_date_symbol_pk" PRIMARY KEY("trading_date","symbol")
);
