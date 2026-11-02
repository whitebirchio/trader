-- capital_flows is insert-only (ADR-008): the record of money in and out.
CREATE TRIGGER "capital_flows_no_update_delete" BEFORE UPDATE OR DELETE ON "capital_flows"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "capital_flows_no_truncate" BEFORE TRUNCATE ON "capital_flows"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "capital_flows" FROM trader_app;
  END IF;
END $$;
