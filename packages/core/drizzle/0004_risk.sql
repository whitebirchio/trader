CREATE TABLE "risk_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gate_run_id" uuid NOT NULL,
	"intent_key" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"sleeve" text NOT NULL,
	"requested_notional" numeric,
	"requested_qty" numeric,
	"approved_notional" numeric,
	"approved_qty" numeric,
	"verdict" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"limits_version" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_gate_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"limits_version" text NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"kill_reason" text,
	"halted" boolean DEFAULT false NOT NULL,
	"halt_reason" text,
	"halted_at" timestamp with time zone,
	"buys_paused_on" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" "audit_actor" DEFAULT 'system' NOT NULL,
	CONSTRAINT "risk_state_singleton" CHECK ("risk_state"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_gate_run_id_risk_gate_runs_id_fk" FOREIGN KEY ("gate_run_id") REFERENCES "public"."risk_gate_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_decisions_intent_idx" ON "risk_decisions" USING btree ("intent_key");--> statement-breakpoint
CREATE INDEX "risk_decisions_run_idx" ON "risk_decisions" USING btree ("gate_run_id");