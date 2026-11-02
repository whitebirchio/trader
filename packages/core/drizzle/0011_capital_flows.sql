CREATE TABLE "capital_flows" (
	"activity_id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"amount" numeric NOT NULL,
	"kind" text NOT NULL,
	"timed_by" text NOT NULL,
	"status" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_flows_kind" CHECK ("capital_flows"."kind" in ('deposit', 'withdrawal', 'reversal')),
	CONSTRAINT "capital_flows_timed_by" CHECK ("capital_flows"."timed_by" in ('created_at', 'booking_date'))
);
--> statement-breakpoint
ALTER TABLE "capital_flows" ADD CONSTRAINT "capital_flows_activity_id_broker_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."broker_activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capital_flows_at_idx" ON "capital_flows" USING btree ("at");