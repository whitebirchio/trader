ALTER TABLE "notifications" ADD COLUMN "week_of" date;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_week_of_key" UNIQUE("week_of");