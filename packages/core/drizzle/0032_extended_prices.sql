CREATE TABLE "extended_prices" (
	"trading_date" date NOT NULL,
	"symbol" text NOT NULL,
	"session" text NOT NULL,
	"price" numeric NOT NULL,
	"bar_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extended_prices_trading_date_symbol_session_pk" PRIMARY KEY("trading_date","symbol","session")
);
