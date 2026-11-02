CREATE TABLE "capital_command_results" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"withdrawal_id" uuid,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"amount" text,
	"requested_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_commands_kind" CHECK ("capital_commands"."kind" in ('request', 'cancel', 'fund_now'))
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text NOT NULL,
	"amount" numeric,
	"withdrawn" numeric DEFAULT '0' NOT NULL,
	"flow_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"command_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"funding_version" integer,
	"funded_by" "audit_actor",
	"updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "withdrawals_status" CHECK ("withdrawals"."status" in ('planning', 'funding', 'settling', 'ready', 'withdrawn', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "capital_command_results" ADD CONSTRAINT "capital_command_results_command_id_capital_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."capital_commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_command_id_capital_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."capital_commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capital_commands_at_idx" ON "capital_commands" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_one_open" ON "withdrawals" USING btree ((true)) WHERE "withdrawals"."status" not in ('withdrawn', 'cancelled');