CREATE TABLE "broker_account" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"account_number" text NOT NULL,
	"status" text NOT NULL,
	"cash" numeric NOT NULL,
	"equity" numeric NOT NULL,
	"long_market_value" numeric NOT NULL,
	"buying_power" numeric NOT NULL,
	"multiplier" text NOT NULL,
	"trading_blocked" boolean NOT NULL,
	"account_blocked" boolean NOT NULL,
	"config" jsonb NOT NULL,
	"trading_allowed" boolean DEFAULT false NOT NULL,
	"blocked_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "broker_account_singleton" CHECK ("broker_account"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "broker_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"symbol" text,
	"side" text,
	"qty" numeric,
	"price" numeric,
	"net_amount" numeric,
	"order_id" text,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equity_snapshots" (
	"trading_date" date PRIMARY KEY NOT NULL,
	"equity" numeric NOT NULL,
	"cash" numeric NOT NULL,
	"long_market_value" numeric NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_order_id" text NOT NULL,
	"intent_key" text,
	"strategy_ref" text,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"notional" numeric,
	"qty" numeric,
	"status" text NOT NULL,
	"broker_order_id" text,
	"filled_qty" numeric,
	"filled_avg_price" numeric,
	"reject_reason" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb,
	CONSTRAINT "orders_client_order_id_key" UNIQUE("client_order_id"),
	CONSTRAINT "orders_broker_order_id_key" UNIQUE("broker_order_id")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"symbol" text PRIMARY KEY NOT NULL,
	"qty" numeric NOT NULL,
	"avg_entry_price" numeric NOT NULL,
	"market_value" numeric NOT NULL,
	"cost_basis" numeric NOT NULL,
	"current_price" numeric NOT NULL,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "broker_activities_type_at_idx" ON "broker_activities" USING btree ("type","at");--> statement-breakpoint
CREATE INDEX "broker_activities_symbol_idx" ON "broker_activities" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");