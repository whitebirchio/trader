CREATE TABLE "rebalance_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trading_date" date NOT NULL,
	"strategy_version" integer NOT NULL,
	"phase" text NOT NULL,
	"targets" jsonb NOT NULL,
	"trades" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"gate_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"version" serial PRIMARY KEY NOT NULL,
	"authored_by" "audit_actor" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text NOT NULL,
	"document" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thesis_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thesis_id" text NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"strategy_version" integer NOT NULL,
	"price" numeric,
	"average_cost" numeric,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rebalance_plans" ADD CONSTRAINT "rebalance_plans_gate_run_id_risk_gate_runs_id_fk" FOREIGN KEY ("gate_run_id") REFERENCES "public"."risk_gate_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rebalance_plans_date_idx" ON "rebalance_plans" USING btree ("trading_date");--> statement-breakpoint
CREATE INDEX "thesis_events_thesis_idx" ON "thesis_events" USING btree ("thesis_id","kind");