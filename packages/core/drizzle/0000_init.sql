CREATE TYPE "public"."audit_actor" AS ENUM('system', 'claude', 'owner');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" "audit_actor" NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"job_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "job_status" NOT NULL,
	"error" text,
	"detail" jsonb,
	CONSTRAINT "job_runs_job_scheduled_for_key" UNIQUE("job","scheduled_for")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_job_run_id_job_runs_id_fk" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at" desc);--> statement-breakpoint
CREATE INDEX "audit_events_kind_at_idx" ON "audit_events" USING btree ("kind","at" desc);--> statement-breakpoint
CREATE INDEX "job_runs_job_status_scheduled_idx" ON "job_runs" USING btree ("job","status","scheduled_for" desc);