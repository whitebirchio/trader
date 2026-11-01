-- strategies, thesis_events and rebalance_plans are insert-only (ADR-008):
-- the record of what Claude decided and what the system did about it.
CREATE TRIGGER "strategies_no_update_delete" BEFORE UPDATE OR DELETE ON "strategies"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "strategies_no_truncate" BEFORE TRUNCATE ON "strategies"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "thesis_events_no_update_delete" BEFORE UPDATE OR DELETE ON "thesis_events"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "thesis_events_no_truncate" BEFORE TRUNCATE ON "thesis_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "rebalance_plans_no_update_delete" BEFORE UPDATE OR DELETE ON "rebalance_plans"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "rebalance_plans_no_truncate" BEFORE TRUNCATE ON "rebalance_plans"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "strategies", "thesis_events", "rebalance_plans" FROM trader_app;
  END IF;
END $$;
